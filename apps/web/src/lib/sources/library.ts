// The Sources library (issue #176, B18): search, filters and sort for the table, and the "linked to" summary of a row.
// Pure: no I/O and no clock, so the rules are unit-tested. The table itself is components/sources/sources-library.tsx.

import type { LinkTargets, SourceKind, SourceLinkRow, SourceListRow, SourceRow } from "@transpera-flow/db";
import { linkLabel } from "./links";
import { SOURCE_KINDS, isId } from "./validate";

export const SORTS = ["newest", "oldest", "title", "title-desc"] as const;
export type SourceSort = (typeof SORTS)[number];

export const SORT_LABELS: Record<SourceSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  title: "Title A to Z",
  "title-desc": "Title Z to A",
};

export interface LibraryQuery {
  /** Words to find in the title, the speakers or the text. */
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

/** The words of a search: split on spaces, at most 10 of at most 100 characters (the database applies the same limits). */
export const searchWords = (search: string): string[] =>
  search
    .trim()
    .slice(0, 300)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
    .map((w) => w.slice(0, 100).toLowerCase());

const EXCERPT_LENGTH = 160;

/** The first words of a text, or the words around the first match of a search: what a row of the library shows instead of the whole text. */
export function excerptOf(body: string | null, search = ""): string {
  const text = body ?? "";
  const lower = text.toLowerCase();
  const at = searchWords(search)
    .map((w) => lower.indexOf(w) + 1)
    .filter((i) => i > 0);
  const from = Math.max((at.length ? Math.min(...at) : 1) - 40, 1);
  return text
    .slice(from - 1, from - 1 + 400)
    .replace(/\s+/g, " ")
    .slice(0, EXCERPT_LENGTH);
}

/** A source as a row of the library: everything but the full text. */
export function toListRow(s: SourceRow, search = ""): SourceListRow {
  const { body, ...rest } = s;
  return { ...rest, excerpt: excerptOf(body, search), has_body: (body ?? "").trim() !== "" };
}

/**
 * The sources that pass the query, in the order it asks for, over sources held in memory (the public demo; a workspace's are searched by
 * the database, `search_sources`). A word matches the title, the speakers or the text; every word must. Ties keep the order given.
 */
export function filterSources(sources: readonly SourceRow[], links: readonly SourceLinkRow[], query: LibraryQuery): SourceRow[] {
  const by = new Map<string, SourceLinkRow[]>();
  for (const l of links) by.set(l.source_id, [...(by.get(l.source_id) ?? []), l]);
  const words = searchWords(query.search);
  const kept = sources.filter((s) => {
    const own = by.get(s.id) ?? [];
    if (query.kind !== "all" && s.kind !== query.kind) return false;
    if (query.unlinkedOnly && own.length > 0) return false;
    if (query.processId !== "all" && !own.some((l) => l.process_id === query.processId)) return false;
    if (words.length) {
      const text = [s.title, s.speakers.join(" "), s.body ?? ""].join("\n").toLowerCase();
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

/** A query that arrived from the browser, checked; null if it isn't one. */
export function parseLibraryQuery(v: unknown): LibraryQuery | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const kindOk = o.kind === "all" || (SOURCE_KINDS as readonly unknown[]).includes(o.kind);
  if (typeof o.search !== "string" || o.search.length > 1000 || !kindOk) return null;
  if (!(o.processId === "all" || isId(o.processId)) || typeof o.unlinkedOnly !== "boolean" || !(SORTS as readonly unknown[]).includes(o.sort)) return null;
  return { search: o.search, kind: o.kind as LibraryQuery["kind"], processId: o.processId as string, unlinkedOnly: o.unlinkedOnly, sort: o.sort as SourceSort };
}

/** How many rows a page of the library holds. */
export const PAGE_SIZE = 50;
