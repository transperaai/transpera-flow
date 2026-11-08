import "server-only";
import { rpc } from "@transpera-flow/db/client";
import { authEnv } from "@/lib/auth/env";
import { getDb, getSessionUser } from "@/lib/auth/session";
import type { DeploymentRule } from "@/lib/deployment-rules";

// The deployment's "Who can sign in" list (migrations 20261228000000 and 20270103000000). Read and written as the signed-in user
// through getDb(), so the database decides: Owners and Agency admins see the rows, Agency admins change everything but Owner rules.

export interface DeploymentAccessView {
  rules: DeploymentRule[];
  /** ACCESS_ADMIN_EMAILS: Owner rules that live in the environment, so they can't be edited here. */
  environmentAdmins: string[];
  /** The signed-in person is an Owner, so they may add, change and remove Owner rules. */
  isOwner: boolean;
}

/** The list for an Owner or an Agency admin, or null for anyone else (and in demo mode). */
export async function loadDeploymentAccess(): Promise<DeploymentAccessView | null> {
  const user = await getSessionUser();
  if (!user) return null;
  const db = await getDb();
  if ((await rpc(db, "is_sign_in_admin")) !== true) return null;
  const rules = await db
    .selectFrom("deployment_access")
    .select(["id", "kind", "value", "role"])
    .orderBy("kind", "desc")
    .orderBy("value")
    .execute();
  return { rules: rules as DeploymentRule[], environmentAdmins: authEnv()?.adminEmails ?? [], isOwner: user.agencyAdmin };
}

export async function insertDeploymentRule(rule: Omit<DeploymentRule, "id">): Promise<void> {
  await (await getDb()).insertInto("deployment_access").values(rule).execute();
}

/** Returns how many rows changed (RLS filters out what the caller may not touch). */
export async function updateDeploymentRole(id: string, role: DeploymentRule["role"]): Promise<number> {
  const res = await (await getDb()).updateTable("deployment_access").set({ role }).where("id", "=", id).executeTakeFirst();
  return Number(res.numUpdatedRows);
}

export async function deleteDeploymentRule(id: string): Promise<number> {
  const res = await (await getDb()).deleteFrom("deployment_access").where("id", "=", id).executeTakeFirst();
  return Number(res.numDeletedRows);
}
