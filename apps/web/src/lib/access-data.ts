import "server-only";
import { cache } from "react";
import type { AccessEmailRow, MembershipRole, WorkspaceDomainRow } from "@transpera-flow/db";
import { rpc, rpcRows } from "@transpera-flow/db/client";
import { getDb, getSessionUser } from "./auth/session";

/**
 * Brings the signed-in user's memberships in line with the workspaces'
 * allowed domains and pre-assigned emails (SECURITY DEFINER function, scoped
 * to the caller). Idempotent; run after every sign-in. Returns how many
 * workspaces the user can now open through a membership.
 */
export async function resolveMyAccess(): Promise<number> {
  const db = await getDb();
  return (await rpcRows(db, "resolve_my_access")).length;
}

/** Whether the signed-in user is an agency admin (may create workspaces). */
export async function isAgencyAdmin(): Promise<boolean> {
  const db = await getDb();
  return (await rpc(db, "is_agency_admin")) === true;
}

export interface WorkspaceMember {
  membershipId: string;
  userId: string;
  email: string;
  role: MembershipRole;
  source: "manual" | "access_list" | "domain";
  active: boolean;
  personId: string | null;
  lastSignInAt: string | null;
}

export interface AccessSettings {
  workspace: { id: string; name: string; slug: string };
  isAgencyAdmin: boolean;
  domains: WorkspaceDomainRow[];
  emails: AccessEmailRow[];
  members: WorkspaceMember[];
  people: { id: string; name: string }[];
}

/** Everything the Access page shows, or null if the user can't manage this workspace. */
export async function loadAccessSettings(slug: string): Promise<AccessSettings | null> {
  const db = await getDb();
  const workspace = await db.selectFrom("workspaces").select(["id", "name", "slug"]).where("slug", "=", slug).executeTakeFirst();
  if (!workspace) return null;
  const ws = workspace.id;
  const [canManage, isAgencyAdmin, domains, emails, members, people] = await Promise.all([
    rpc(db, "can_manage_workspace", { ws }),
    rpc(db, "is_agency_admin"),
    db.selectFrom("workspace_domains").select(["id", "workspace_id", "domain"]).where("workspace_id", "=", ws).orderBy("domain").execute(),
    db.selectFrom("workspace_access_emails").select(["id", "workspace_id", "email", "role", "person_id"]).where("workspace_id", "=", ws).orderBy("email").execute(),
    rpcRows(db, "workspace_members", { ws }),
    db.selectFrom("people").select(["id", "name"]).where("workspace_id", "=", ws).orderBy("name").execute(),
  ]);
  if (!canManage) return null;
  return {
    workspace,
    isAgencyAdmin: Boolean(isAgencyAdmin),
    domains: domains as WorkspaceDomainRow[],
    // The check constraint keeps agency_admin off the list.
    emails: emails as AccessEmailRow[],
    members: (members ?? []).map((m) => ({
      membershipId: m.membership_id,
      userId: m.user_id,
      email: m.email,
      role: m.role,
      source: m.source as WorkspaceMember["source"],
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

/** The signed-in user as others see them in presence (issue #10): id, a display name and email. */
export const currentViewer = cache(async (): Promise<{ userId: string; name: string; email: string | null } | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const email = user.email || null;
  return { userId: user.id, name: user.name ?? email?.split("@")[0] ?? "Someone", email };
});

/** Whether the signed-in user can edit the workspace's processes and people (RLS helper). */
export const canEditWorkspace = cache(async (workspaceId: string): Promise<boolean> => {
  return (await rpc(await getDb(), "can_edit_workspace", { ws: workspaceId })) === true;
});

/** Whether the signed-in user can manage the workspace's access (RLS helper). */
export const canManageWorkspace = cache(async (workspaceId: string): Promise<boolean> => {
  return Boolean(await rpc(await getDb(), "can_manage_workspace", { ws: workspaceId }));
});
