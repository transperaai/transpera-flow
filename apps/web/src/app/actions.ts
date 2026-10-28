"use server";

import { redirect } from "next/navigation";
import { rpc } from "@transpera-flow/db/client";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";
import { parseNewWorkspace } from "@/lib/workspaces";

// Creating a workspace from the home page (issue #88; docs/adr/0012-*). Only
// agency admins may: `create_workspace` checks that in the database, as the
// signed-in user, and gives the creator an agency_admin membership.

export interface CreateWorkspaceState {
  error?: string;
}

export async function createWorkspace(_prev: CreateWorkspaceState, form: FormData): Promise<CreateWorkspaceState> {
  const parsed = parseNewWorkspace(form);
  if ("error" in parsed) return parsed;
  const user = await getSessionUser();
  if (!user) return { error: "Your session has ended. Sign in again." };
  const db = await getDb();

  try {
    await rpc(db, "create_workspace", { ws_name: parsed.name, ws_slug: parsed.slug, ws_settings: parsed.settings });
  } catch (e) {
    const code = pgCode(e);
    if (code === "42501") return { error: "Only the Owner can create workspaces." };
    if (code === "23505") return { error: `The address /w/${parsed.slug} is already taken. Choose another.` };
    if (code === "23514" || code === "22023") return { error: "Some of those values aren't allowed." };
    return { error: "Couldn't create it. Try again." };
  }
  // redirect throws, so it stays outside any try.
  redirect(`/w/${encodeURIComponent(parsed.slug)}`);
}
