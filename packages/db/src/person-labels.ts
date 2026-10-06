// Who may see which person's name (B1 2b, issue #30). Pure: no database.
import type { Viewer } from "./queries";

/** What a reader gets for anyone they may not see (Austin, 6 Oct: their own name, "A team member" for everyone else). */
export const A_TEAM_MEMBER = "A team member";

/** True when the viewer sees `personId`: everyone, or their own person. Never for a null or missing id. */
export function canSeePerson(v: Viewer, personId: string | null | undefined): boolean {
  if (v.seesEveryone) return true;
  return personId != null && personId !== "" && personId === v.ownPersonId;
}
