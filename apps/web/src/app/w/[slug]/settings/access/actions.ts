"use server";

import { redirect } from "next/navigation";
import { accessErrorMessage, isAssignableRole, normalizeDomain, normalizeEmail } from "@/lib/access";
import { createClient } from "@/lib/supabase/server";

// Every action runs as the signed-in user; RLS (owner or agency admin only)
// decides whether the change is allowed, and database triggers apply it to
// affected members and write the audit log.

type DbError = { code?: string; message: string };

async function signedInClient() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return supabase;
}

function done(slug: string, error: DbError | null, notice: string): never {
  const params = new URLSearchParams(error ? { error: accessErrorMessage(error) } : { notice });
  redirect(`/w/${encodeURIComponent(slug)}/settings/access?${params}`);
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

/** Updates and deletes that RLS filters out match no rows instead of failing; report those too. */
function outcome({ data, error }: { data: unknown[] | null; error: DbError | null }): DbError | null {
  if (error) return error;
  return data && data.length > 0 ? null : { code: "42501", message: "no rows changed" };
}

function roleFrom(slug: string, form: FormData) {
  const role = text(form, "role");
  if (!isAssignableRole(role)) done(slug, { message: "invalid role" }, "");
  return role;
}

export async function addDomain(slug: string, workspaceId: string, form: FormData) {
  const supabase = await signedInClient();
  const domain = normalizeDomain(text(form, "domain"));
  const { error } = await supabase.from("workspace_domains").insert({ workspace_id: workspaceId, domain });
  done(slug, error, `Added ${domain}.`);
}

export async function removeDomain(slug: string, form: FormData) {
  const supabase = await signedInClient();
  const result = await supabase.from("workspace_domains").delete().eq("id", text(form, "id")).select("id");
  done(slug, outcome(result), "Removed the domain. People who joined through it no longer have access.");
}

export async function addEmail(slug: string, workspaceId: string, form: FormData) {
  const supabase = await signedInClient();
  const email = normalizeEmail(text(form, "email"));
  const role = roleFrom(slug, form);
  const personId = text(form, "person_id") || null;
  const { error } = await supabase
    .from("workspace_access_emails")
    .insert({ workspace_id: workspaceId, email, role, person_id: personId });
  done(slug, error, `Added ${email} as ${role}.`);
}

export async function updateEmail(slug: string, form: FormData) {
  const supabase = await signedInClient();
  const role = roleFrom(slug, form);
  const personId = text(form, "person_id") || null;
  const result = await supabase
    .from("workspace_access_emails")
    .update({ role, person_id: personId })
    .eq("id", text(form, "id"))
    .select("id");
  done(slug, outcome(result), "Saved.");
}

export async function removeEmail(slug: string, form: FormData) {
  const supabase = await signedInClient();
  const result = await supabase.from("workspace_access_emails").delete().eq("id", text(form, "id")).select("id");
  done(slug, outcome(result), "Removed from the list. If they had signed in, they have lost access.");
}

/** Role change for a member who is not on the list (joined by domain or added by hand). */
export async function setMemberRole(slug: string, form: FormData) {
  const supabase = await signedInClient();
  const role = roleFrom(slug, form);
  const result = await supabase.from("memberships").update({ role }).eq("id", text(form, "id")).select("id");
  done(slug, outcome(result), "Role updated.");
}

/** Links a member (however they joined) to their person record, or clears the link. Members on the list take it from the list row. */
export async function setMemberPerson(slug: string, form: FormData) {
  const supabase = await signedInClient();
  const personId = text(form, "person_id") || null;
  const result = await supabase.from("memberships").update({ person_id: personId }).eq("id", text(form, "id")).select("id");
  done(slug, outcome(result), personId ? "Linked to the person." : "Unlinked from the person.");
}

/** Deactivated members keep their row (so a domain can't re-add them) but get no access. */
export async function setMemberActive(slug: string, form: FormData) {
  const supabase = await signedInClient();
  const active = text(form, "active") === "true";
  const result = await supabase.from("memberships").update({ active }).eq("id", text(form, "id")).select("id");
  done(slug, outcome(result), active ? "Access restored." : "Access removed.");
}
