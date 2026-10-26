"use server";

import { redirect } from "next/navigation";
import { accessErrorMessage, isAssignableRole, normalizeDomain, normalizeEmail, personLinkProblem } from "@/lib/access";
import { pgError } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";
import { deleteDeploymentRule, insertDeploymentRule, updateDeploymentRole } from "@/lib/deployment-access";
import { deploymentErrorMessage, isDeploymentRole, normalizeRuleValue } from "@/lib/deployment-rules";

// Every action runs as the signed-in user; RLS (owner or agency admin only)
// decides whether the change is allowed, and database triggers apply it to
// affected members and write the audit log.

type DbError = { code?: string; message: string };

async function signedInClient() {
  if (!(await getSessionUser())) redirect("/login");
  return getDb();
}

const dbError = (e: unknown): DbError => {
  const { code, message } = pgError(e);
  return { code, message: message ?? "" };
};

function done(slug: string, error: DbError | null, notice: string): never {
  const params = new URLSearchParams(error ? { error: accessErrorMessage(error) } : { notice });
  redirect(`/w/${encodeURIComponent(slug)}/settings/access?${params}`);
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

/** Updates and deletes that RLS filters out match no rows instead of failing; report those too. */
async function outcome(run: () => Promise<unknown[]>): Promise<DbError | null> {
  try {
    const data = await run();
    return data.length > 0 ? null : { code: "42501", message: "no rows changed" };
  } catch (e) {
    return dbError(e);
  }
}

function roleFrom(slug: string, form: FormData) {
  const role = text(form, "role");
  if (!isAssignableRole(role)) done(slug, { message: "invalid role" }, "");
  return role;
}

export async function addDomain(slug: string, workspaceId: string, form: FormData) {
  const db = await signedInClient();
  const domain = normalizeDomain(text(form, "domain"));
  let error: DbError | null = null;
  try {
    await db.insertInto("workspace_domains").values({ workspace_id: workspaceId, domain }).execute();
  } catch (e) {
    error = dbError(e);
  }
  done(slug, error, `Added ${domain}.`);
}

export async function removeDomain(slug: string, form: FormData) {
  const db = await signedInClient();
  const result = await outcome(() => db.deleteFrom("workspace_domains").where("id", "=", text(form, "id")).returning("id").execute());
  done(slug, result, "Removed the domain. People who joined through it no longer have access.");
}

export async function addEmail(slug: string, workspaceId: string, form: FormData) {
  const db = await signedInClient();
  const email = normalizeEmail(text(form, "email"));
  const role = roleFrom(slug, form);
  const personId = text(form, "person_id") || null;
  let error: DbError | null = null;
  try {
    await db.insertInto("workspace_access_emails").values({ workspace_id: workspaceId, email, role, person_id: personId }).execute();
  } catch (e) {
    error = dbError(e);
  }
  done(slug, error, `Added ${email} as ${role}.`);
}

export async function updateEmail(slug: string, form: FormData) {
  const db = await signedInClient();
  const role = roleFrom(slug, form);
  const personId = text(form, "person_id") || null;
  const result = await outcome(() => db.updateTable("workspace_access_emails").set({ role, person_id: personId }).where("id", "=", text(form, "id")).returning("id").execute());
  done(slug, result, "Saved.");
}

export async function removeEmail(slug: string, form: FormData) {
  const db = await signedInClient();
  const result = await outcome(() => db.deleteFrom("workspace_access_emails").where("id", "=", text(form, "id")).returning("id").execute());
  done(slug, result, "Removed from the list. If they had signed in, they have lost access.");
}

/** Role change for a member who is not on the list (joined by domain or added by hand). */
export async function setMemberRole(slug: string, form: FormData) {
  const db = await signedInClient();
  const role = roleFrom(slug, form);
  const result = await outcome(() => db.updateTable("memberships").set({ role }).where("id", "=", text(form, "id")).returning("id").execute());
  done(slug, result, "Role updated.");
}

/** Links a member (however they joined) to their person record, or clears the link. Members on the list take it from the list row. */
export async function setMemberPerson(slug: string, form: FormData) {
  const db = await signedInClient();
  const personId = text(form, "person_id") || null;
  const id = text(form, "id");
  if (personId) {
    // One membership per person, enforced here rather than in the database (see personLinkProblem).
    const mine = await db.selectFrom("memberships").select("workspace_id").where("id", "=", id).executeTakeFirst().catch(() => undefined);
    if (mine) {
      const [others, list] = await Promise.all([
        db.selectFrom("memberships").select(["id", "person_id", "active"]).where("workspace_id", "=", mine.workspace_id).where("person_id", "=", personId).execute().catch(() => []),
        db.selectFrom("workspace_access_emails").select("person_id").where("workspace_id", "=", mine.workspace_id).where("person_id", "=", personId).execute().catch(() => []),
      ]);
      const problem = personLinkProblem(id, personId, others, list);
      if (problem) redirect(`/w/${encodeURIComponent(slug)}/settings/access?${new URLSearchParams({ error: problem })}`);
    }
  }
  const result = await outcome(() => db.updateTable("memberships").set({ person_id: personId }).where("id", "=", id).returning("id").execute());
  done(slug, result, personId ? "Linked to the person." : "Unlinked from the person.");
}

/** Deactivated members keep their row (so a domain can't re-add them) but get no access. */
export async function setMemberActive(slug: string, form: FormData) {
  const db = await signedInClient();
  const active = text(form, "active") === "true";
  const result = await outcome(() => db.updateTable("memberships").set({ active }).where("id", "=", text(form, "id")).returning("id").execute());
  done(slug, result, active ? "Access restored." : "Access removed.");
}

// "Who can sign in" (deployment-wide, agency admins only). These run on the new data layer (getDb), as the signed-in user; RLS on
// public.deployment_access decides, and a change applies at the person's next request (getSessionUser checks the list again).

async function deploymentDone(slug: string, work: () => Promise<number | void>, notice: string): Promise<never> {
  if (!(await getSessionUser())) redirect("/login");
  let error: DbError | null = null;
  try {
    const changed = await work();
    if (changed === 0) error = { code: "42501", message: "no rows changed" };
  } catch (e) {
    error = e as DbError;
  }
  const params = new URLSearchParams(error ? { error: deploymentErrorMessage(error) } : { notice });
  redirect(`/w/${encodeURIComponent(slug)}/settings/access?${params}`);
}

export async function addDeploymentRule(slug: string, form: FormData) {
  const kind = text(form, "kind") === "email" ? "email" : "domain";
  const role = text(form, "role");
  if (!isDeploymentRole(role)) return deploymentDone(slug, () => Promise.reject({ message: "invalid role" }), "");
  const value = normalizeRuleValue(kind, text(form, "value"));
  await deploymentDone(slug, () => insertDeploymentRule({ kind, value, role }), `${value} can now sign in as ${role}.`);
}

export async function setDeploymentRole(slug: string, form: FormData) {
  const role = text(form, "role");
  if (!isDeploymentRole(role)) return deploymentDone(slug, () => Promise.reject({ message: "invalid role" }), "");
  await deploymentDone(slug, () => updateDeploymentRole(text(form, "id"), role), "Saved.");
}

export async function removeDeploymentRule(slug: string, form: FormData) {
  await deploymentDone(slug, () => deleteDeploymentRule(text(form, "id")), "Removed. They are signed out at their next page load.");
}
