"use server";

import { saveLeverSettings, type LeverSettings } from "@transpera-flow/db";
import { cleanHidden } from "@/lib/scenarios/lever-catalogue";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Saves which levers a workspace shows (issue #123). Runs as the signed-in user through RLS: owners and editors
// write, everyone else is refused. Ids that aren't lever kinds are dropped, so a hand-made request can't store them.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SaveLeversResult =
  | { status: "saved"; settings: LeverSettings }
  | { status: "conflict"; settings: LeverSettings }
  | { status: "error"; message: string };

export async function saveLevers(workspaceId: string, hidden: unknown, version: string | null): Promise<SaveLeversResult> {
  if (!UUID.test(workspaceId) || !Array.isArray(hidden) || !(version === null || typeof version === "string")) return { status: "error", message: "That isn't valid." };
  if (!(await getSessionUser())) return { status: "error", message: "Your session has ended. Sign in again." };
  const outcome = await saveLeverSettings(await getDb(), workspaceId, cleanHidden(hidden), version);
  switch (outcome.status) {
    case "saved":
    case "conflict":
      return outcome;
    case "forbidden":
      return { status: "error", message: "Only owners and editors can change the levers." };
    case "invalid":
    case "error":
      return { status: "error", message: outcome.message };
  }
}
