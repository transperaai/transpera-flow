// Who may see which person's name (B1 2b, issue #30; decision log: Austin, 6 Oct). Pure: no database, so the web app and
// the tests all use the one rule. (The "Team member A" labels AI text was saved with went with in-app AI,
// docs/plans/cut-list.md item 1.)

import type { Viewer } from "./queries";

/** What a reader gets for anyone they may not see (Austin, 6 Oct: their own name, "A team member" for everyone else). */
export const A_TEAM_MEMBER = "A team member";

/** True when the viewer sees `personId`: everyone, or their own person. Never for a null or missing id. */
export function canSeePerson(v: Viewer, personId: string | null | undefined): boolean {
  if (v.seesEveryone) return true;
  return personId != null && personId !== "" && personId === v.ownPersonId;
}

/**
 * An issue's `detected_key` for a reader. An acknowledged pre-B17 AI insight is keyed `ai:insight:<hash of its real-name
 * text>`, so a reader who doesn't see everyone could hash guessed names and check them. They get `ai:insight:<issue id>`
 * instead: the prefix readers check is kept, and it is unique and stable. Keys the engine writes (`overtime:person:<id>`,
 * `finding:ai:<id>`, ...; an issue acknowledged from a finding keeps its key, but nothing reads it as a finding now) carry ids, never names, and are left alone. Members can't write issues, so nothing sends it back.
 */
export function hideAiIssueKey<T extends { id: string; detected_key: string | null }>(row: T, seesEveryone: boolean): T {
  if (seesEveryone || !row.detected_key?.startsWith("ai:insight:")) return row;
  return { ...row, detected_key: `ai:insight:${row.id}` };
}
