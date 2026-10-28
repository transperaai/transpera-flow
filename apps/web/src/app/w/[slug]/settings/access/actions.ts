"use server";

import { redirect } from "next/navigation";
import { pgError } from "@/app/action-db";
import { personLinkProblem } from "@/lib/access";
import { getDb, getSessionUser } from "@/lib/auth/session";
import { deleteDeploymentRule, insertDeploymentRule, updateDeploymentRole } from "@/lib/deployment-access";
import { deploymentErrorMessage, isDeploymentRole, normalizeRuleValue } from "@/lib/deployment-rules";

// Settings > Access. Every action runs as the signed-in user and the database decides (row-level security): "Who can sign in" is
// open to the Owner and Agency admins, and only the Owner changes an Owner rule. A change applies at the person's next request
// (getSessionUser checks the list again) and their next sign-in (the sync makes their memberships match it).

type DbError = { code?: string; message: string };

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

const back = (slug: string, params: Record<string, string>): never => redirect(`/w/${encodeURIComponent(slug)}/settings/access?${new URLSearchParams(params)}`);

/** Updates and deletes that RLS filters out match no rows instead of failing; report those too. */
async function outcome(run: () => Promise<unknown[]>): Promise<DbError | null> {
  try {
    const data = await run();
    return data.length > 0 ? null : { code: "42501", message: "no rows changed" };
  } catch (e) {
    const { code, message } = pgError(e);
    return { code, message: message ?? "" };
  }
}

/** Links a signed-in person to their person record, or clears the link. Only the Owner and Agency admins may (RLS). */
export async function setMemberPerson(slug: string, form: FormData) {
  if (!(await getSessionUser())) redirect("/login");
  const db = await getDb();
  const personId = text(form, "person_id") || null;
  const id = text(form, "id");
  if (personId) {
    // One membership per person, enforced here rather than in the database (see personLinkProblem).
    const mine = await db.selectFrom("memberships").select("workspace_id").where("id", "=", id).executeTakeFirst().catch(() => undefined);
    if (mine) {
      const others = await db
        .selectFrom("memberships")
        .select(["id", "person_id", "active"])
        .where("workspace_id", "=", mine.workspace_id)
        .where("person_id", "=", personId)
        .execute()
        .catch(() => []);
      const problem = personLinkProblem(id, personId, others);
      if (problem) back(slug, { error: problem });
    }
  }
  const result = await outcome(() => db.updateTable("memberships").set({ person_id: personId }).where("id", "=", id).returning("id").execute());
  if (result) back(slug, { error: "You don't have permission to change that." });
  back(slug, { notice: personId ? "Linked to the person." : "Unlinked from the person." });
}

// "Who can sign in" (deployment-wide). These run on the new data layer (getDb), as the signed-in user; RLS on public.deployment_access
// decides.

async function deploymentDone(slug: string, work: () => Promise<number | void>, notice: string): Promise<never> {
  if (!(await getSessionUser())) redirect("/login");
  let error: DbError | null = null;
  try {
    const changed = await work();
    if (changed === 0) error = { code: "42501", message: "no rows changed" };
  } catch (e) {
    error = e as DbError;
  }
  return back(slug, error ? { error: deploymentErrorMessage(error) } : { notice });
}

export async function addDeploymentRule(slug: string, form: FormData) {
  const kind = text(form, "kind") === "email" ? "email" : "domain";
  const role = text(form, "role");
  if (!isDeploymentRole(role)) return deploymentDone(slug, () => Promise.reject({ message: "invalid role" }), "");
  const value = normalizeRuleValue(kind, text(form, "value"));
  await deploymentDone(slug, () => insertDeploymentRule({ kind, value, role }), `${value} can now sign in as ${roleWord(role)}.`);
}

export async function setDeploymentRole(slug: string, form: FormData) {
  const role = text(form, "role");
  if (!isDeploymentRole(role)) return deploymentDone(slug, () => Promise.reject({ message: "invalid role" }), "");
  await deploymentDone(slug, () => updateDeploymentRole(text(form, "id"), role), "Saved. It applies when they next sign in.");
}

export async function removeDeploymentRule(slug: string, form: FormData) {
  await deploymentDone(slug, () => deleteDeploymentRule(text(form, "id")), "Removed. They are signed out at their next page load.");
}

const roleWord = (role: string): string => (role === "owner" ? "an Owner" : role === "agency_admin" ? "an Agency admin" : "a Viewer");
