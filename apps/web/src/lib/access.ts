// Pure helpers for the workspace Access page (issue #51). The database is the
// authority on every rule (free-mail domains, formats, who may edit); these
// only tidy input and turn its errors into sentences.

export const ASSIGNABLE_ROLES = ["owner", "editor", "member", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/** "  @Acme.COM " or "https://www.acme.com/" -> "acme.com"; "x@acme.com" -> "acme.com". */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  if (d.includes("@")) d = d.slice(d.lastIndexOf("@") + 1);
  return d.replace(/^www\./, "").replace(/\.$/, "");
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** The part after @, lower-cased. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

interface DbError {
  code?: string;
  message?: string;
}

/** A sentence for an error returned by Supabase when changing access settings. */
export function accessErrorMessage(error: DbError): string {
  const m = error.message ?? "";
  if (m.includes("workspace_keeps_an_owner")) {
    return "A workspace needs at least one owner. Make someone else an owner first.";
  }
  if (m.includes("workspace_domains_not_free_mail")) {
    return "Free email providers (like gmail.com) can't be allowed domains. Add those people by email instead.";
  }
  if (m.includes("workspace_domains_domain_format")) return "That doesn't look like a domain, e.g. acme.com.";
  if (m.includes("workspace_domains_domain_key")) return "That domain is already used by a workspace.";
  if (m.includes("workspace_access_emails_email_format")) return "That doesn't look like an email address.";
  if (m.includes("workspace_access_emails_workspace_email_key")) return "That email is already on the list.";
  if (m.includes("workspace_access_emails_role_check")) return "Agency admins are set by Transpera, not the access list.";
  if (error.code === "42501" || m.includes("row-level security")) return "You don't have permission to change access here.";
  return "Something went wrong saving that change. Please try again.";
}

/** What an owner sends to someone they have given access to. Transpera Flow sends no emails: signing in with Google is accepting. */
export function inviteMessage(workspaceName: string, email: string, origin: string): string {
  return `You've been given access to ${workspaceName} in Transpera Flow. Sign in with Google as ${email} at ${origin.replace(/\/+$/, "")}/login.`;
}

/**
 * The people an access-page picker should offer: everyone not already linked to another membership or list row. `links` says who is
 * linked to what (a list row and the membership it made count as one: they carry the same person); `own` is the row being edited,
 * whose current person stays on offer. Pass no `own` for a new row.
 */
export function selectablePeople<P extends { id: string }>(people: P[], links: ReadonlyMap<string, ReadonlySet<string>>, own?: string): P[] {
  return people.filter((p) => {
    const taken = links.get(p.id);
    return !taken || [...taken].every((k) => k === own);
  });
}
