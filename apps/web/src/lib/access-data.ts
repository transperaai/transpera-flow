import "server-only";
import { cache } from "react";
import type { AccessEmailRow, MembershipRole, WorkspaceDomainRow } from "@transpera-flow/db";
import { getSessionUser } from "./auth/session";
import { createClient } from "./supabase/server";

/**
 * Brings the signed-in user's memberships in line with the workspaces'
 * allowed domains and pre-assigned emails (SECURITY DEFINER function, scoped
 * to the caller). Idempotent; run after every sign-in. Returns how many
 * workspaces the user can now open through a membership.
 */
export async function resolveMyAccess(): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("resolve_my_access");
  if (error) throw error;
  return data.length;
}

/** Whether the signed-in user is an agency admin (may create workspaces). */
export async function isAgencyAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_agency_admin");
  if (error) throw error;
  return data === true;
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
  const supabase = await createClient();
  const { data: workspace, error } = await supabase.from("workspaces").select("id, name, slug").eq("slug", slug).maybeSingle();
  if (error) throw error;
  if (!workspace) return null;
  const ws = workspace.id;
  const [canManage, isAgencyAdmin, domains, emails, members, people] = await Promise.all([
    supabase.rpc("can_manage_workspace", { ws }),
    supabase.rpc("is_agency_admin"),
    supabase.from("workspace_domains").select("id, workspace_id, domain").eq("workspace_id", ws).order("domain"),
    supabase.from("workspace_access_emails").select("id, workspace_id, email, role, person_id").eq("workspace_id", ws).order("email"),
    supabase.rpc("workspace_members", { ws }),
    supabase.from("people").select("id, name").eq("workspace_id", ws).order("name"),
  ]);
  for (const r of [canManage, isAgencyAdmin, domains, emails, members, people]) if (r.error) throw r.error;
  if (!canManage.data) return null;
  return {
    workspace,
    isAgencyAdmin: Boolean(isAgencyAdmin.data),
    domains: domains.data ?? [],
    // The check constraint keeps agency_admin off the list.
    emails: (emails.data ?? []) as AccessEmailRow[],
    members: (members.data ?? []).map((m) => ({
      membershipId: m.membership_id,
      userId: m.user_id,
      email: m.email,
      role: m.role,
      source: m.source as WorkspaceMember["source"],
      active: m.active,
      personId: m.person_id,
      lastSignInAt: m.last_sign_in_at,
    })),
    people: people.data ?? [],
  };
}

/** The signed-in user's id, or null. */
export async function currentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  return typeof sub === "string" ? sub : null;
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
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("can_edit_workspace", { ws: workspaceId });
  if (error) throw error;
  return data === true;
});

/** Whether the signed-in user can manage the workspace's access (RLS helper). */
export const canManageWorkspace = cache(async (workspaceId: string): Promise<boolean> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("can_manage_workspace", { ws: workspaceId });
  if (error) throw error;
  return Boolean(data);
});
