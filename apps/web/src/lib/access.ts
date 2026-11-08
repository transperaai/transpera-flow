// Pure helpers for Settings > Access (issue #51; three roles since migration 20270103000000). The database is the authority on every
// rule (free-mail domains, formats, who may change what); these only tidy input and pick who a person record can be linked to.

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

/**
 * The people an access-page picker should offer: everyone not already linked to another membership. `links` says who is linked to
 * which membership; `own` is the row being edited, whose current person stays on offer.
 */
export function selectablePeople<P extends { id: string }>(people: P[], links: ReadonlyMap<string, ReadonlySet<string>>, own?: string): P[] {
  return people.filter((p) => {
    const taken = links.get(p.id);
    return !taken || [...taken].every((k) => k === own);
  });
}

/**
 * Why a person can't be linked to a membership, or null when they can: another active membership in the workspace already holds
 * them. The page hides such people; the action checks again, since a form can send anything. The database has no unique constraint
 * on purpose (an existing duplicate would then break the sign-in sync).
 */
export function personLinkProblem(
  membershipId: string,
  personId: string,
  memberships: readonly { id: string; person_id: string | null; active: boolean }[],
): string | null {
  const taken = memberships.some((m) => m.id !== membershipId && m.active && m.person_id === personId);
  return taken ? "That person is already linked to someone else in this workspace. Unlink them first." : null;
}
