// Who is looking, and what they may see of other people (B1 2b, issue #30).
//
// Owners, editors and agency admins see every person. A member or viewer sees their own person's row, and "A team
// member" wherever another person would be named. A bundle with no `viewer` (the demo, fixtures) sees everyone.
import { A_TEAM_MEMBER, canSeePerson, type Viewer } from "@transpera-flow/db";

export { canSeePerson };

export const SEES_EVERYONE: Viewer = { seesEveryone: true, ownPersonId: null };

/** The bundle's viewer; a bundle without one (the demo, fixtures) sees everyone. */
export function viewerOf(x: { viewer?: Viewer } | null | undefined): Viewer {
  return x?.viewer ?? SEES_EVERYONE;
}

/** "A team member" for anyone the viewer can't see (Q2). */
export function personName(v: Viewer, personId: string, name: string): string {
  return canSeePerson(v, personId) ? name : A_TEAM_MEMBER;
}

/** The same list with other people's names replaced by "A team member", for building name maps. */
export function namedForViewer<P extends { id: string; name: string }>(v: Viewer, people: readonly P[]): P[] {
  return people.map((p) => (canSeePerson(v, p.id) ? p : { ...p, name: A_TEAM_MEMBER }));
}

/** Only the viewer's own row, unless they see everyone. */
export function ownRowsOnly<T>(v: Viewer, rows: readonly T[], personIdOf: (row: T) => string): T[] {
  return v.seesEveryone ? [...rows] : rows.filter((r) => canSeePerson(v, personIdOf(r)));
}
