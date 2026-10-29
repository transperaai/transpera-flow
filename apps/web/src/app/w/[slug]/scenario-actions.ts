"use server";

import { carryNotes, changesFromPatch, wholeRunPatches, type SandboxChange, type ScenarioRow } from "@transpera-flow/db";
import { parsePatches } from "@transpera-flow/engine";
import { sql } from "kysely";
import { isId, parseScenarioInput } from "@/lib/scenarios/validate";
import { buildOnRefusal } from "@/lib/sandbox/save-errors";
import type { RemoveScenarioResult, SaveScenarioResult } from "@/lib/scenarios/store";
import { jsonb, pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

const SCENARIO_COLS = ["id", "workspace_id", "name", "description", "changes"] as const;

/** A `sandbox_scenarios` row as the process page's scenario: its changes as patches (it only ever writes whole-run patch scenarios). */
const asScenario = (row: { id: string; workspace_id: string; name: string; description: string | null; changes: unknown }): ScenarioRow => ({
  id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  description: row.description,
  patch: wholeRunPatches(row.changes as SandboxChange[]) ?? [],
  parent_scenario_id: null,
});

// Saving and deleting scenarios (issue #15), now rows of `sandbox_scenarios`: the process page's scenarios are the standalone whole-run
// ones (no parent, every change a patch), written as changes and read back as patches. Every write runs as the signed-in
// user through RLS (editors, owners and agency admins may write; everyone in
// the workspace may read and apply). The checks in lib/scenarios/validate.ts
// only reject malformed input early; the database checks the patch shape too.
// Nothing here refreshes the page: the panel already shows the change.

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "You don't have permission to change scenarios here." } as const;

async function signedInClient() {
  return (await getSessionUser()) ? getDb() : null;
}

const failure = (e: unknown) => {
  const code = pgCode(e);
  return code === "42501"
    ? forbidden
    : code === "23514"
      ? ({ status: "error", message: "Some of those changes aren't allowed." } as const)
      : code === "23505"
        ? ({ status: "error", message: "A scenario with that name already exists." } as const)
        : ({ status: "error", message: "Couldn't save. Try again." } as const);
};

/** Save a new scenario (from the levers, or a duplicate) in the workspace. */
export async function createScenario(workspaceId: unknown, input: unknown): Promise<SaveScenarioResult> {
  if (!isId(workspaceId)) return { status: "error", message: "That scenario isn't valid." };
  const parsed = parseScenarioInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const db = await signedInClient();
  if (!db) return signedOut;
  // A copy no longer builds on its source: it holds its own changes (`parent_scenario_id` is ignored).
  const { patch, name, description } = parsed.value;
  try {
    const data = await db
      .insertInto("sandbox_scenarios")
      .values({ name, description, changes: jsonb(changesFromPatch(patch)), parent_id: null, workspace_id: workspaceId })
      .returning(SCENARIO_COLS)
      .executeTakeFirstOrThrow();
    return { status: "ok", scenario: asScenario(data) };
  } catch (e) {
    return failure(e);
  }
}

/** Delete a scenario. A row that is gone, or that the user may not delete, reads as forbidden. */
export async function deleteScenario(id: unknown): Promise<RemoveScenarioResult> {
  if (!isId(id)) return { status: "error", message: "That scenario isn't valid." };
  const db = await signedInClient();
  if (!db) return signedOut;
  let data;
  try {
    data = await db.deleteFrom("sandbox_scenarios").where("id", "=", id).returning("id").execute();
  } catch (e) {
    if (pgCode(e) === "23503") {
      const children = await db.selectFrom("sandbox_scenarios").select("name").where("parent_id", "=", id).orderBy("name").execute().catch(() => []);
      return { status: "error", message: buildOnRefusal(children.map((c) => c.name)) };
    }
    return failure(e);
  }
  if (!data.length) return forbidden;
  return { status: "ok" };
}

/**
 * Replace a scenario's patches (issue #16: re-pointing a change whose step was
 * split or deleted). Last write wins, like the rest of a scenario's row; RLS
 * decides who may. A row that is gone, or that the user may not change, reads
 * as forbidden.
 */
export async function updateScenarioPatch(id: unknown, patch: unknown): Promise<SaveScenarioResult> {
  if (!isId(id)) return { status: "error", message: "That scenario isn't valid." };
  const parsed = parsePatches(patch);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  if (!parsed.patches.length) return { status: "error", message: "A scenario needs at least one change." };
  const db = await signedInClient();
  if (!db) return signedOut;
  let data;
  try {
    // Only a standalone scenario made of whole-run patches is the process page's to change: one with a parent, a hire or a change from
    // a month is the Sandbox's, and replacing its changes with patches would lose them.
    const current = await db.selectFrom("sandbox_scenarios").select("changes").where("id", "=", id).where("parent_id", "is", null).executeTakeFirst();
    if (!current || wholeRunPatches(current.changes as unknown as SandboxChange[]) === null) return forbidden;
    data = await db
      .updateTable("sandbox_scenarios")
      .set({ changes: jsonb(carryNotes(current.changes as unknown as SandboxChange[], changesFromPatch(parsed.patches))) })
      .where("id", "=", id)
      .where("parent_id", "is", null)
      // Only if the Sandbox hasn't changed it since it was read (a change from a month added there would otherwise be overwritten).
      .where(sql<boolean>`changes = ${JSON.stringify(current.changes)}::jsonb`)
      .returning(SCENARIO_COLS)
      .execute();
  } catch (e) {
    return failure(e);
  }
  if (!data.length) return forbidden;
  return { status: "ok", scenario: asScenario(data[0]!) };
}
