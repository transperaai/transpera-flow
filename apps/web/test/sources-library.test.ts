import { describe, expect, it } from "vitest";
import type { SourceLinkRow, SourceRow } from "@transpera-flow/db";
import { demoBundle, demoLinkTargets, demoPageSources, demoSourceLinks } from "../src/lib/sources/demo";
import { DEFAULT_QUERY, excerptOf, filterSources, isFiltered, linkedSummary, parseLibraryQuery, searchWords, sourceDate, toListRow, type LibraryQuery } from "../src/lib/sources/library";

// The Sources library's search, filters, sort and "linked to" column (issue #176, B18). The table in a browser is
// sources-library-browser.test.ts.

const targets = demoLinkTargets(demoBundle());
const [p1, p2] = targets.processes;
const WS = "w";
const src = (id: string, over: Partial<SourceRow> = {}): SourceRow => ({
  id,
  workspace_id: WS,
  kind: "notes",
  title: `Source ${id}`,
  speakers: [],
  recorded_at: null,
  body: null,
  file_url: null,
  created_at: "2026-09-01T09:00:00Z",
  updated_at: "2026-09-01T09:00:00Z",
  ...over,
});
const link = (id: string, sourceId: string, over: Partial<SourceLinkRow>): SourceLinkRow => ({
  id,
  workspace_id: WS,
  source_id: sourceId,
  kind: "process",
  process_id: null,
  step_id: null,
  insight_key: null,
  issue_id: null,
  solution_id: null,
  created_at: "2026-09-01T09:00:00Z",
  created_by: null,
  ...over,
});
const q = (over: Partial<LibraryQuery> = {}): LibraryQuery => ({ ...DEFAULT_QUERY, ...over });
const ids = (rows: SourceRow[]) => rows.map((r) => r.id);

const sources = [
  src("a", { title: "Strategy walkthrough", kind: "transcript", speakers: ["Maya Collins"], recorded_at: "2026-09-12", body: "A proper audit takes a day." }),
  src("b", { title: "ops notes", kind: "notes", speakers: ["Leah Brooks"], recorded_at: "2026-09-18", body: "Access requests go back and forth." }),
  src("c", { title: "Billing export", kind: "data", recorded_at: null, created_at: "2026-10-01T09:00:00Z", body: "invoice,amount" }),
  src("d", { title: "Screenshot of CRM", kind: "screenshot", recorded_at: "2026-08-30" }),
];
const links = [
  link("l1", "a", { kind: "process", process_id: p1!.id }),
  link("l2", "b", { kind: "step", process_id: p2!.id, step_id: targets.steps.find((s) => s.processId === p2!.id)!.id }),
  link("l3", "c", { kind: "issue", issue_id: targets.issues[0]!.id }),
];

describe("filtering", () => {
  it("shows everything by default", () => {
    expect(ids(filterSources(sources, links, DEFAULT_QUERY)).sort()).toEqual(["a", "b", "c", "d"]);
    expect(isFiltered(DEFAULT_QUERY)).toBe(false);
  });

  it("searches the title, speakers and text, ignoring case, all words needed", () => {
    expect(ids(filterSources(sources, links, q({ search: "STRATEGY" })))).toEqual(["a"]);
    expect(ids(filterSources(sources, links, q({ search: "leah" })))).toEqual(["b"]);
    expect(ids(filterSources(sources, links, q({ search: "back and forth" })))).toEqual(["b"]);
    // What a source is linked to is not searched: filter by process for that.
    expect(ids(filterSources(sources, links, q({ search: `process: ${p1!.name.toLowerCase()}` })))).toEqual([]);
    expect(ids(filterSources(sources, links, q({ search: "audit maya" })))).toEqual(["a"]);
    expect(ids(filterSources(sources, links, q({ search: "audit leah" })))).toEqual([]);
    expect(filterSources(sources, links, q({ search: "  " })).length).toBe(4);
  });

  it("filters by kind", () => {
    expect(ids(filterSources(sources, links, q({ kind: "data" })))).toEqual(["c"]);
    expect(ids(filterSources(sources, links, q({ kind: "transcript" })))).toEqual(["a"]);
  });

  it("filters by process, counting a link to one of its steps", () => {
    expect(ids(filterSources(sources, links, q({ processId: p1!.id })))).toEqual(["a"]);
    expect(ids(filterSources(sources, links, q({ processId: p2!.id })))).toEqual(["b"]);
  });

  it("can show only the sources linked to nothing", () => {
    expect(ids(filterSources(sources, links, q({ unlinkedOnly: true }))).sort()).toEqual(["d"]);
  });

  it("combines filters, and says when any is on", () => {
    expect(ids(filterSources(sources, links, q({ kind: "notes", processId: p2!.id })))).toEqual(["b"]);
    expect(ids(filterSources(sources, links, q({ kind: "transcript", processId: p2!.id })))).toEqual([]);
    for (const over of [{ search: "x" }, { kind: "data" as const }, { processId: p1!.id }, { unlinkedOnly: true }]) expect(isFiltered(q(over))).toBe(true);
  });
});

describe("sorting", () => {
  it("sorts by date, newest or oldest first; a source without a date is filed under the day it was added", () => {
    expect(sourceDate(sources[2]!)).toBe("2026-10-01");
    expect(ids(filterSources(sources, links, q({ sort: "newest" })))).toEqual(["c", "b", "a", "d"]);
    expect(ids(filterSources(sources, links, q({ sort: "oldest" })))).toEqual(["d", "a", "b", "c"]);
  });

  it("sorts by title, ignoring case", () => {
    expect(ids(filterSources(sources, links, q({ sort: "title" })))).toEqual(["c", "b", "d", "a"]);
    expect(ids(filterSources(sources, links, q({ sort: "title-desc" })))).toEqual(["a", "d", "b", "c"]);
  });

  it("keeps a stable order for equal dates (by title) and does not change the list it is given", () => {
    const same = [src("x", { title: "Zed", recorded_at: "2026-09-01" }), src("y", { title: "Alpha", recorded_at: "2026-09-01" })];
    expect(ids(filterSources(same, [], q({ sort: "newest" })))).toEqual(["y", "x"]);
    expect(ids(same)).toEqual(["x", "y"]);
  });
});

describe("the linked-to summary", () => {
  it("names processes (a step counts as its process), issues and solutions, once each", () => {
    const sol = { id: "s1", name: "AI lead qualifier" };
    const withSolutions = { ...targets, solutions: [sol] };
    const own = [
      link("1", "a", { kind: "process", process_id: p1!.id }),
      link("2", "a", { kind: "step", process_id: p1!.id, step_id: "step-1" }),
      link("3", "a", { kind: "issue", issue_id: targets.issues[0]!.id }),
      link("4", "a", { kind: "solution", solution_id: sol.id }),
      link("5", "a", { kind: "insight", insight_key: "k" }),
    ];
    const s = linkedSummary(own, withSolutions);
    expect(s.processes).toEqual([p1!.name]);
    expect(s.issues).toEqual([`#${targets.issues[0]!.number}`]);
    expect(s.solutions).toEqual(["AI lead qualifier"]);
    expect(s.other).toBe(2);
  });

  it("is empty for a source linked to nothing", () => {
    expect(linkedSummary([], targets)).toEqual({ processes: [], issues: [], solutions: [], other: 0 });
  });

  it("matches the demo's sample: one source is linked to nothing", () => {
    const unlinked = filterSources(demoPageSources(), demoSourceLinks(), q({ unlinkedOnly: true }));
    expect(unlinked.map((s) => s.title)).toEqual(["Notes: ops walkthrough with Leah"]);
  });
});

describe("rows without the full text", () => {
  const long = `${"Intake goes back and forth. ".repeat(40)}Then the refund policy is checked by Dana. ${"More words. ".repeat(40)}`;

  it("keeps a row to the first 160 characters, or the words around the first match", () => {
    expect(excerptOf(null)).toBe("");
    expect(excerptOf("  \n ")).toBe(" ");
    expect(excerptOf(long).length).toBeLessThanOrEqual(160);
    expect(excerptOf(long).startsWith("Intake goes back")).toBe(true);
    const around = excerptOf(long, "DANA");
    expect(around).toContain("Dana");
    expect(around.length).toBeLessThanOrEqual(160);
  });

  it("makes a list row with no body and says whether there is text", () => {
    const row = toListRow(src("z", { body: long }));
    expect("body" in row).toBe(false);
    expect(row.has_body).toBe(true);
    expect(row.excerpt.length).toBeLessThanOrEqual(160);
    expect(toListRow(src("y", { body: "   " })).has_body).toBe(false);
    expect(toListRow(src("x", { body: null })).has_body).toBe(false);
    expect(JSON.stringify(toListRow(src("z", { body: long }))).length).toBeLessThan(1000);
  });

  it("reads a search as at most 10 words of at most 100 characters", () => {
    expect(searchWords("  Refund   DANA ")).toEqual(["refund", "dana"]);
    expect(searchWords("a ".repeat(30)).length).toBe(10);
    expect(searchWords("x".repeat(500))[0]!.length).toBe(100);
  });
});

describe("a query from the browser", () => {
  it("is accepted when it is a query, and refused otherwise", () => {
    expect(parseLibraryQuery(DEFAULT_QUERY)).toEqual(DEFAULT_QUERY);
    expect(parseLibraryQuery({ ...DEFAULT_QUERY, kind: "sop", sort: "title", unlinkedOnly: true, search: "x" })).not.toBeNull();
    for (const bad of [null, "x", 4, {}, { ...DEFAULT_QUERY, kind: "video" }, { ...DEFAULT_QUERY, sort: "random" }, { ...DEFAULT_QUERY, processId: "not-an-id" }, { ...DEFAULT_QUERY, search: 5 }, { ...DEFAULT_QUERY, unlinkedOnly: "yes" }, { ...DEFAULT_QUERY, search: "x".repeat(1001) }]) {
      expect(parseLibraryQuery(bad)).toBeNull();
    }
  });
});
