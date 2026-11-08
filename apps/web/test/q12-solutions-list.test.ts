import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IssueRow } from "@transpera-flow/db";
import { northbeamIssues, NORTHBEAM_PROCESS_ID } from "@transpera-flow/db";
import { NO_ISSUE_REFUSAL } from "@/lib/editor/modes";
import { NO_ISSUE, issuesBySolution, logIssueHref, matchesIssueFilter, searchIssues, startSolutionHref, startableIssues } from "@/lib/solutions/list";
import { solutionEditorHref } from "@/lib/solutions/links";

// Q12: the Solutions list, "New solution" from an issue, and the Editor refusing a solution with no issue.

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const issues = northbeamIssues();
const published = new Set([NORTHBEAM_PROCESS_ID]);
const base = "/w/example";

describe("which issues a new solution can start from", () => {
  it("lists open issues that are about a published process, by number", () => {
    const list = startableIssues(issues, published);
    expect(list.length).toBeGreaterThan(0);
    for (const i of list) expect(["open", "in_progress", "testing"]).toContain(i.status);
    expect(list.map((i) => i.number)).toEqual([...list.map((i) => i.number)].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it("leaves out closed issues, detections, and issues about a process with nothing published", () => {
    const [first] = issues as [IssueRow];
    const closed = { ...first, id: "c", status: "resolved" } as IssueRow;
    const detected = { ...first, id: "d", source: "detected" } as IssueRow;
    const elsewhere = { ...first, id: "e", process_id: "other", links: [] } as IssueRow;
    const open = { ...first, id: "o", status: "open", source: "manual" } as IssueRow;
    expect(startableIssues([closed, detected, elsewhere, open], published).map((i) => i.id)).toEqual(["o"]);
    expect(startableIssues([open], new Set())).toEqual([]);
  });

  it("searches by number, title and process name", () => {
    const [first] = issues as [IssueRow];
    const mine = [{ ...first, id: "a", number: 12, title: "Leads wait too long" }, { ...first, id: "b", number: 15, title: "Invoices are late" }] as IssueRow[];
    const name = () => "Sales";
    expect(searchIssues(mine, "", name)).toHaveLength(2);
    expect(searchIssues(mine, "#12", name).map((i) => i.id)).toEqual(["a"]);
    expect(searchIssues(mine, "invoices", name).map((i) => i.id)).toEqual(["b"]);
    expect(searchIssues(mine, "sales", name)).toHaveLength(2);
    expect(searchIssues(mine, "zzz", name)).toEqual([]);
  });

  it("opens the Editor in solution mode on the issue's process, with the issue linked, and back to the list", () => {
    const [first] = issues as [IssueRow];
    const issue = { ...first, id: "3f1c2b4a-0000-4000-8000-000000000001", links: [{ ...(first.links[0] ?? {}), process_id: NORTHBEAM_PROCESS_ID }] } as IssueRow;
    const href = startSolutionHref(base, issue, `${base}/solutions`)!;
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe(`${base}/p/${NORTHBEAM_PROCESS_ID}/edit`);
    expect(url.searchParams.get("mode")).toBe("solution");
    expect(url.searchParams.get("issue")).toBe(issue.id);
    expect(url.searchParams.get("from")).toBe(`${base}/solutions`);
  });

  it("sends 'Log a new issue' to the Issues list with the dialog open and the Editor to follow", () => {
    expect(logIssueHref(base)).toBe("/w/example/issues?new=1&then=solution");
  });
});

describe("filtering the list by issue", () => {
  const linked = issuesBySolution([
    { solution_id: "s1", issue_id: "i1" },
    { solution_id: "s1", issue_id: "i2" },
    { solution_id: "s2", issue_id: "i2" },
  ]);
  it("shows everything with no choice, one issue's solutions, or the ones with no issue", () => {
    const all = ["s1", "s2", "s3"].map((id) => ({ id }));
    const pick = (sel: string[]) => all.filter((s) => matchesIssueFilter(s, linked, sel)).map((s) => s.id);
    expect(pick([])).toEqual(["s1", "s2", "s3"]);
    expect(pick(["i1"])).toEqual(["s1"]);
    expect(pick(["i2"])).toEqual(["s1", "s2"]);
    expect(pick([NO_ISSUE])).toEqual(["s3"]);
    expect(pick(["i1", NO_ISSUE])).toEqual(["s1", "s3"]);
  });
});

describe("every solution is tied to an issue", () => {
  it("the Editor refuses to save one with none, in plain words, with the two ways out", () => {
    expect(NO_ISSUE_REFUSAL).toBe(
      "Pick the issue this solution fixes. To change the process without an issue, edit the process itself (a new draft), or save the steps to the Block library.",
    );
    const view = read("components/editor/editor-view.tsx");
    expect(view).toMatch(/if \(!issue\) \{\s*setRefusedWithout\(true\);\s*return setSolutionError\(NO_ISSUE_REFUSAL\);/);
    // The refusal comes before anything is sent.
    expect(view.indexOf("NO_ISSUE_REFUSAL);")).toBeLessThan(view.indexOf("createSolution(live.workspace.id"));
    const bar = read("components/editor/editor-bar.tsx");
    expect(bar).toContain("Edit the process instead");
    expect(bar).toContain("Save as a block");
    const page = read("components/editor/workspace-editor-page.tsx");
    expect(page).toContain("processEditorHref=");
    expect(page).toContain("mode=block");
  });

  it("the Solutions list has the columns and the Issue filter, and 'No issue' with a 'Link an issue' action", () => {
    const list = read("components/solutions/solutions-list.tsx");
    for (const t of ["Solution", "Fixes", "Status", "Process", "Updated", 'name="Issue"', "NO_ISSUE_WORDS", "LinkIssueButton"]) expect(list).toContain(t);
    expect(read("lib/solutions/list.ts")).toContain('NO_ISSUE_WORDS = "No issue"');
    expect(read("components/solutions/new-solution.tsx")).toContain("Link an issue");
    expect(read("components/solutions/new-solution.tsx")).toContain("linkSolutionToIssue");
  });

  it("the process page's New solution also asks for the issue first", () => {
    expect(read("components/solutions/process-solutions.tsx")).toContain("<NewSolutionButton");
  });

  it("'Try a new solution' on an issue lands pre-linked: the href carries the issue id", () => {
    const [first] = issues as [IssueRow];
    const page = read("app/w/[slug]/issues/[number]/page.tsx");
    expect(page).toContain("buildHref={buildSolutionHref(");
    expect(solutionEditorHref(base, NORTHBEAM_PROCESS_ID, { issueId: first.id })).toContain(`issue=${first.id}`);
  });

  it("the Issues list opens the New issue dialog from ?new=1 and goes on to the Editor after ?then=solution", () => {
    const src = read("components/issues-page.tsx");
    expect(src).toContain('params.get("new") === "1"');
    expect(src).toContain('params.get("then") === "solution"');
    expect(src).toContain("startSolutionHref(");
  });
});

describe("the Solution page's three ways on (D44)", () => {
  it("the Solution page has no Try it in the Sandbox button (QA round 2); the Sandbox still opens on a solution picked by its address", () => {
    expect(read("components/solutions/solution-page.tsx")).not.toContain("/sandbox?solution=");
    expect(read("app/w/[slug]/sandbox/page.tsx")).toContain("initialSolutionId=");
    // The pick is the Sandbox's own map-version state (E6), from the first month, and only for a solution the page lists.
    const view = read("components/sandbox/play-view.tsx");
    expect(view).toContain("versions: { [pick.processId]: { solution: pick.id, month: 0 } }");
    expect(view).toContain("p.solutions.some((s) => s.id === pick.id)");
  });

  it("Open in editor starts solution mode from the solution's own copy, linked to its issue, measured against live", () => {
    const page = read("components/editor/workspace-editor-page.tsx");
    expect(page).toContain("bundleFromSolution(live, fromSolution)");
    expect(page).toContain("s.process_id === live.process.id");
    const view = read("components/editor/editor-view.tsx");
    expect(view).toContain("const live = fromSolution ? initialLive : drafts.live;");
    expect(read("components/solutions/solution-page.tsx")).toContain("&solution=${solution.id}");
  });

});
