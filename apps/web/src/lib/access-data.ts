import "server-only";
import { cache } from "react";
import type { MembershipRole } from "@transpera-flow/db";
import { rpc, rpcRows } from "@transpera-flow/db/client";
import { getDb, getSessionUser } from "./auth/session";

/** Whether the signed-in user is the Owner (the agency-admin flag; may create workspaces). */
export async function isAgencyAdmin(): Promise<boolean> {
  const db = await getDb();
  return (await rpc(db, "is_agency_admin")) === true;
}

/** Someone who has signed in to a workspace: an `owner` membership is an Agency admin, a `viewer` one a Viewer. */
export interface WorkspaceMember {
  membershipId: string;
  userId: string;
  email: string;
  role: MembershipRole;
  active: boolean;
  personId: string | null;
  lastSignInAt: string | null;
}

export interface AccessSettings {
  workspace: { id: string; name: string; slug: string };
  members: WorkspaceMember[];
  people: { id: string; name: string }[];
}

/** Everything the Access page shows about a workspace's people, or null if the user can't manage this workspace. */
export async function loadAccessSettings(slug: string): Promise<AccessSettings | null> {
  const db = await getDb();
  const workspace = await db.selectFrom("workspaces").select(["id", "name", "slug"]).where("slug", "=", slug).executeTakeFirst();
  if (!workspace) return null;
  const ws = workspace.id;
  const [canManage, members, people] = await Promise.all([
    rpc(db, "can_manage_workspace", { ws }),
    rpcRows(db, "workspace_members", { ws }),
    db.selectFrom("people").select(["id", "name"]).where("workspace_id", "=", ws).orderBy("name").execute(),
  ]);
  if (!canManage) return null;
  return {
    workspace,
    members: (members ?? []).map((m) => ({
      membershipId: m.membership_id,
      userId: m.user_id,
      // auth.users.email is nullable, though the Better Auth mirror always sets it.
      email: m.email ?? "",
      role: m.role as MembershipRole,
      active: m.active,
      personId: m.person_id,
      lastSignInAt: m.last_sign_in_at,
    })),
    people,
  };
}

/** The signed-in user's id, or null. */
export async function currentUserId(): Promise<string | null> {
  return (await getSessionUser())?.id ?? null;
}

/** The signed-in user: id, a display name and email. */
export const currentViewer = cache(async (): Promise<{ userId: string; name: string; email: string | null } | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const email = user.email || null;
  return { userId: user.id, name: user.name ?? email?.split("@")[0] ?? "Someone", email };
});

/** Whether the signed-in user can edit the workspace's processes and people (the Owner or an Agency admin; RLS helper). */
export const canEditWorkspace = cache(async (workspaceId: string): Promise<boolean> => {
  return (await rpc(await getDb(), "can_edit_workspace", { ws: workspaceId })) === true;
});

/** Whether the signed-in user can manage the workspace's settings and who is linked to whom (the Owner or an Agency admin). */
export const canManageWorkspace = cache(async (workspaceId: string): Promise<boolean> => {
  return Boolean(await rpc(await getDb(), "can_manage_workspace", { ws: workspaceId }));
});
