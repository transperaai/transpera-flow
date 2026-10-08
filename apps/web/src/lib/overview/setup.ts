import type { SetupCounts } from "@transpera-flow/db";

// The start page's checklist (issue #243): what a new client's workspace needs, ticked from cheap counts. Counts are never shown,
// only ticks, and only to editors (members and viewers are never sent them).

export type SetupKey = "roles" | "people" | "clients" | "process" | "publish";

export interface SetupItem {
  key: SetupKey;
  label: string;
  href: string;
  done: boolean;
}

/**
 * The five steps in order. `base` is `/w/<slug>`; `firstDraft` is the oldest draft-only process, if any, which is what
 * "Publish it" opens.
 */
export function setupChecklist(
  counts: Pick<SetupCounts, "roles" | "people" | "clients" | "clientGroups" | "processes" | "published">,
  base: string,
  firstDraft: { id: string } | null,
): SetupItem[] {
  return [
    { key: "roles", label: "Add roles", href: `${base}/settings#roles-heading`, done: counts.roles > 0 },
    { key: "people", label: "Add people", href: `${base}/settings#people-heading`, done: counts.people > 0 },
    { key: "clients", label: "Add clients or client groups", href: `${base}/settings#clients-heading`, done: counts.clients + counts.clientGroups > 0 },
    { key: "process", label: "Start the first process", href: `${base}/processes`, done: counts.processes > 0 },
    { key: "publish", label: "Publish it", href: firstDraft ? `${base}/p/${firstDraft.id}/edit` : `${base}/processes`, done: counts.published > 0 },
  ];
}
