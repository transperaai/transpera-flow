// Process history (issue #105, A40): the pure parts. A version is a published revision; its row on the History
// screen says when it went live, who published it, and what changed.
// No React, no database.

/** What changed since the version before: how many steps and connections were added, removed and changed (moving a step on the canvas is not a change). */
export interface RevisionChanges {
  steps: { added: number; removed: number; changed: number };
  edges: { added: number; removed: number; changed: number };
}

export type AuthorKind = "user" | "mcp" | "system";

/** One published version, as the History table lists it. */
export interface VersionMeta {
  revisionId: string;
  number: number;
  /** The version people are using now. */
  live: boolean;
  publishedAt: string | null;
  authorKind: AuthorKind | null;
  /** A person's name, when the workspace knows it. */
  authorName: string | null;
  changes: RevisionChanges | null;
  /** What a system-made version did, in words ("Added Sales"): only the company map's versions made by sync have one. */
  note?: string | null;
}

/** "Claude (MCP)" for a publish through MCP, else the person's name. */
export function authorLabel(v: Pick<VersionMeta, "authorKind" | "authorName">): string {
  if (v.authorKind === "mcp") return "Claude (MCP)";
  if (v.authorKind === "system") return "System";
  if (v.authorName) return v.authorName;
  // A signed-in person the workspace has no name for, or a version that was there before anyone kept track.
  return v.authorKind === "user" ? "A team member" : "Imported";
}

const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * What changed in a version, in plain words: "3 steps changed, 1 step added, 2 connections removed". `first` is the
 * oldest version, which has nothing to be compared with.
 */
export function describeChanges(changes: RevisionChanges | null, first: boolean): string {
  if (first) return "First version";
  if (!changes) return "Changes weren't recorded";
  const parts: string[] = [];
  const groups = [
    [changes.steps, "step", "steps"],
    [changes.edges, "connection", "connections"],
  ] as const;
  for (const [c, one, many] of groups) {
    for (const [n, verb] of [[c.changed, "changed"], [c.added, "added"], [c.removed, "removed"]] as const) {
      if (n > 0) parts.push(`${n} ${noun(n, one, many)} ${verb}`);
    }
  }
  if (parts.length === 0) return "Nothing changed (published again as it was)";
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Reads the counts `revision_history` returns, or null if it isn't that shape. */
export function parseChanges(value: unknown): RevisionChanges | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, Record<string, unknown>>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  const one = (k: "steps" | "edges") => ({ added: n(v[k]?.added), removed: n(v[k]?.removed), changed: n(v[k]?.changed) });
  return { steps: one("steps"), edges: one("edges") };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "29 Sep 2026", in UTC so the server and the browser print the same day (and the same month name, whatever the locale data). */
export function formatPublished(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
