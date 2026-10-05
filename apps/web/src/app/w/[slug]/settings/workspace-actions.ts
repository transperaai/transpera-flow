"use server";

import { refresh } from "next/cache";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField } from "@/lib/fields/server";
import { CLIENT_FIELDS, isId } from "@/lib/clients";
import { createClient } from "@/lib/supabase/server";

// The workspace's name and currency (issue #182, B19), from Settings. As the signed-in user through row-level security:
// owners and agency admins change the workspace; the database also checks both values (20261201000000).

const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;

async function signedIn(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims?.sub);
}

/** The workspace's name, as everyone in it sees it. Owners only. */
export async function saveWorkspaceName(workspaceId: string, base: string | null, value: string | null): Promise<SaveOutcome<string | null>> {
  if (!isId(workspaceId) || typeof value !== "string" || !CLIENT_FIELDS.name(value) || !(base === null || typeof base === "string")) return invalid;
  if (!(await signedIn())) return signedOut;
  const out = await saveField("workspaces", { id: workspaceId }, "name", base, value.trim());
  if (out.status === "saved") refresh();
  return out;
}

/** The currency every amount is shown in: a three-letter code. Owners only. */
export async function saveWorkspaceCurrency(workspaceId: string, base: string | null, value: string | null): Promise<SaveOutcome<string | null>> {
  if (!isId(workspaceId) || typeof value !== "string" || !/^[A-Z]{3}$/.test(value) || !(base === null || typeof base === "string")) return invalid;
  if (!(await signedIn())) return signedOut;
  const out = await saveField("workspaces", { id: workspaceId }, "settings.currency", base, value);
  if (out.status === "saved") refresh();
  return out;
}
