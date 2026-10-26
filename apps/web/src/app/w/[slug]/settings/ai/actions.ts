"use server";

import { saveAiSetting, type AiSettings } from "@transpera-flow/db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Saves one switch of Settings -> AI analysis (issue #111, A46), per workspace. Runs as the signed-in user through RLS:
// owners and editors write, everyone else is refused. Only that switch is written, so two people flipping different
// switches can't undo each other.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SaveAiSettingResult = { status: "saved"; settings: AiSettings } | { status: "error"; message: string };

export async function saveAiSwitch(workspaceId: string, key: string, value: boolean): Promise<SaveAiSettingResult> {
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId) || typeof key !== "string" || typeof value !== "boolean") return { status: "error", message: "That isn't valid." };
  if (!(await getSessionUser())) return { status: "error", message: "Your session has ended. Sign in again." };
  const out = await saveAiSetting(await getDb(), workspaceId, key, value);
  switch (out.status) {
    case "saved":
      return out;
    case "forbidden":
      return { status: "error", message: "Only owners and editors can change the AI switches." };
    case "invalid":
      return { status: "error", message: "That isn't valid." };
    case "error":
      return { status: "error", message: out.message };
  }
}
