// The Sources library (issue #176, B18): search, filters and sort for the table, and the "linked to" summary of a row.
// Pure: no I/O and no clock, so the rules are unit-tested. The table itself is components/sources/sources-library.tsx.

import type { LinkTargets, SourceKind, SourceLinkRow, SourceRow } from "@transpera-flow/db";
import { linkLabel } from "./links";

export const SORTS = ["newest", "oldest", "title", "title-desc"] as const;
export type SourceSort = (typeof SORTS)[number];

export const SORT_LABELS: Record<SourceSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  title: "Title A to Z",
  "title-desc": "Title Z to A",
};

export interface LibraryQuery {
  /** Words to find in the title, speakers, text or what it is linked to. */
  search: string;
  /** Only this kind of source, or every kind. */
  kind: SourceKind | "all";
  /** Only sources linked to this process (or one of its steps), or all. */
  processId: string | "all";
  /** Only sources linked to nothing. */
  unlinkedOnly: boolean;
  sort: SourceSort;
}

export const DEFAULT_QUERY: LibraryQuery = { search: "", kind: "all", processId: "all", unlinkedOnly: false, sort: "newest" };

/** The date a source is filed under: when it was recorded, else when it was added. */
export const sourceDate = (s: Pick<SourceRow, "recorded_at" | "created_at">): string => s.recorded_at ?? s.created_at.slice(0, 10);

/** What a source is linked to, by group, as the table's "Linked to" column shows it. */
export interface LinkedSummary {
  processes: string[];
  issues: string[];
  solutions: string[];
  /** Steps and insights, which belong to a process or to the analysis rather than to a group of their own. */
  other: number;
}

const unique = (list: string[]) => [...new Set(list)];

/** A source's links as names: the processes (a step counts as its process), issues and solutions. */
export function linkedSummary(links: readonly SourceLinkRow[], targets: LinkTargets): LinkedSummary {
  const processName = (id: string | null) => targets.processes.find((p) => p.id === id)?.name;
  const processes: string[] = [];
  const issues: string[] = [];
  const solutions: string[] = [];
  let other = 0;
  for (const l of links) {
    if (l.kind === "process" || l.kind === "step") {
      const name = processName(l.process_id);
      if (name) processes.push(name);
      if (l.kind === "step") other += 1;
    } else if (l.kind === "issue") issues.push(linkLabel(l, targets).replace(/^Issue:? /, ""));
    else if (l.kind === "solution") solutions.push(linkLabel(l, targets).replace(/^Solution: /, ""));
    else other += 1;
  }
  return { processes: unique(processes), issues: unique(issues), solutions: unique(solutions), other };
}

/** Every word a search can match for a source, lower-cased. */
function haystack(source: SourceRow, links: readonly SourceLinkRow[], targets: LinkTargets): string {
  return [source.title, source.speakers.join(" "), source.body ?? "", links.map((l) => linkLabel(l, targets)).join(" ")].join("\n").toLowerCase();
}

/** The sources that pass the query, in the order it asks for. Ties keep the order given. */
export function filterSources(sources: readonly SourceRow[], links: readonly SourceLinkRow[], targets: LinkTargets, query: LibraryQuery): SourceRow[] {
  const by = new Map<string, SourceLinkRow[]>();
  for (const l of links) by.set(l.source_id, [...(by.get(l.source_id) ?? []), l]);
  const words = query.search.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = sources.filter((s) => {
    const own = by.get(s.id) ?? [];
    if (query.kind !== "all" && s.kind !== query.kind) return false;
    if (query.unlinkedOnly && own.length > 0) return false;
    if (query.processId !== "all" && !own.some((l) => l.process_id === query.processId)) return false;
    if (words.length) {
      const text = haystack(s, own, targets);
      return words.every((w) => text.includes(w));
    }
    return true;
  });
  const cmpTitle = (a: SourceRow, b: SourceRow) => a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true });
  const cmpDate = (a: SourceRow, b: SourceRow) => sourceDate(a).localeCompare(sourceDate(b));
  const order: Record<SourceSort, (a: SourceRow, b: SourceRow) => number> = {
    newest: (a, b) => cmpDate(b, a) || cmpTitle(a, b),
    oldest: (a, b) => cmpDate(a, b) || cmpTitle(a, b),
    title: cmpTitle,
    "title-desc": (a, b) => cmpTitle(b, a),
  };
  return [...kept].sort(order[query.sort]);
}

/** Whether the query narrows anything: "Clear filters" shows only then. */
export const isFiltered = (q: LibraryQuery) => q.search.trim() !== "" || q.kind !== "all" || q.processId !== "all" || q.unlinkedOnly;
