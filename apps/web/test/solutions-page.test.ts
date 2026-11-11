import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamIssues, northbeamStepIds as ids, type IssueEventRow, type SolutionIssueRow, type SolutionRow } from "@transpera-flow/db";
import { RESOLVE_HELP } from "@/lib/issues/help";
import { historyText, resolvedBar } from "@/lib/issues/pages";
import { MemoryIssueStore } from "@/lib/issues/store";
import { workspaceNav } from "@/lib/shell/nav";
import {
  NO_SOLUTIONS_DATA,
  builtBy,
  changedStepNames,
  changesLine,
  effectiveVerdict,
  linkableIssues,
  solutionHref,
  solutionSummaries,
  solutionsForIssue,
  type SolutionsData,
} from "@/lib/solutions/cards";
import { addDemoLink, addDemoSolution, setDemoNotes, setDemoVerdict } from "@/lib/solutions/demo";
import { RESOLVE_SOLUTION_HELP, SOLUTIONS_LIST_HELP, SOLUTION_PAGE_HELP, newOnProcessHelp } from "@/lib/solutions/help";
import { solutionCopy } from "@/lib/solutions/bundle";
import { demoBundle } from "@/lib/sources/demo";

// The Solutions list and the Solution page (issue #115, A50 slice 1): what the cards say, the verdicts, resolving an issue with a
// solution, the demo's in-memory solutions, and the (i) on every control.

const issues = northbeamIssues();
const [issueA, issueB] = issues;
const live = demoBundle();
const stamp = "2026-10-05T10:00:00.000Z";

const solution = (id: string, extra: Partial<SolutionRow> = {}): SolutionRow => ({
  id,
  workspace_id: NORTHBEAM_WORKSPACE_ID,
  process_id: NORTHBEAM_PROCESS_ID,
  base_revision_id: live.revision.id,
  name: `Solution ${id}`,
  notes: "",
  status: "testing",
  steps: solutionCopy(live),
  changed_step_ids: [ids.audit],
  lever_changes: [],
  step_changes: [],
  created_at: stamp,
  updated_at: stamp,
  created_by: "u1",
  ...extra,
});
const link = (solutionId: string, issueId: string, extra: Partial<SolutionIssueRow> = {}): SolutionIssueRow => ({
  solution_id: solutionId,
  issue_id: issueId,
  workspace_id: NORTHBEAM_WORKSPACE_ID,
  auto_verdict: "pass",
  holds_pct: 92,
  auto_note: "ok",
  user_verdict: null,
  user_notes: "",
  created_at: stamp,
  updated_at: stamp,
  created_by: "u1",
  ...extra,
});

describe("the cards", () => {
  const data: SolutionsData = {
    solutions: [solution("s1", { name: "AI lead qualifier" }), solution("s2", { created_at: "2026-10-06T10:00:00.000Z" })],
    links: [link("s1", issueA!.id), link("s1", issueB!.id, { auto_verdict: "fail", holds_pct: 30, user_verdict: "pass" }), link("s2", issueA!.id, { auto_verdict: null, holds_pct: null })],
  };

  it("names the steps a solution changes, from its own copy", () => {
    expect(changedStepNames(data.solutions[0]!)).toEqual(["Audit & proposal"]);
    expect(changesLine(data.solutions[0]!)).toBe("Audit & proposal");
    expect(changesLine(solution("x", { changed_step_ids: [] }))).toBe("nothing yet");
    expect(changesLine(solution("x", { changed_step_ids: [], lever_changes: [{ path: "a", op: "set", value: 1 }] as never }))).toBe("1 lever change");
    const many = solution("x", { changed_step_ids: live.steps.map((s) => s.id) });
    expect(changesLine(many, 2)).toMatch(/^.+, .+ and \d+ more$/);
  });

  it("counts your verdict over the automatic one", () => {
    expect(effectiveVerdict(data.links[1]!)).toBe("pass");
    expect(effectiveVerdict(data.links[2]!)).toBeNull();
  });

  it("says who built it", () => {
    expect(builtBy("u1", "u1")).toBe("You");
    expect(builtBy("u1", "u2")).toBe("A team member");
    expect(builtBy(null, "u2")).toBe("Someone");
    expect(builtBy(null, null, true)).toBe("You");
  });

  it("lists an issue's solutions newest first, for the Issue page and the list's counts; only a person's Pass counts (QA round 2)", () => {
    expect(solutionsForIssue(data, issueA!.id).map((x) => x.solution.id)).toEqual(["s2", "s1"]);
    // Issue A's links carry a stored automatic pass and no verdict of the person's: tested, but not passed. Issue B has the person's Pass.
    expect(solutionSummaries(data)).toEqual({
      [issueA!.id]: { tested: 2, passed: false },
      [issueB!.id]: { tested: 1, passed: true },
    });
    const yours = { ...data, links: data.links.map((l) => (l.solution_id === "s1" ? { ...l, user_verdict: "pass" as const } : l)) };
    expect(solutionSummaries(yours)[issueA!.id]).toEqual({ tested: 2, passed: true });
    expect(solutionSummaries(NO_SOLUTIONS_DATA)).toEqual({});
    expect(solutionHref("/demo", "s1")).toBe("/demo/solutions/s1");
  });

  it("offers only open or testing issues about the process that are not already linked, and never a detection", () => {
    const open = { ...issueA!, status: "open" as const, source: "manual" as const };
    const done = { ...issueB!, status: "resolved" as const };
    const detected = { ...issueA!, id: "d", status: "open" as const, source: "detected" as const };
    const elsewhere = { ...issueA!, id: "e", status: "open" as const, process_id: "other", links: [] };
    const got = linkableIssues([open, done, detected, elsewhere], NORTHBEAM_PROCESS_ID, new Set());
    expect(got.map((i) => i.id)).toEqual([open.id]);
    expect(linkableIssues([open], NORTHBEAM_PROCESS_ID, new Set([open.id]))).toEqual([]);
  });
});

describe("resolving with a solution", () => {
  const sol = { id: "00000000-0000-4000-8000-0000000000bb", name: "AI lead qualifier" };
  let store: MemoryIssueStore;
  const target = issues[0]!.id;
  beforeEach(() => {
    store = new MemoryIssueStore(NORTHBEAM_WORKSPACE_ID, issues);
  });

  it("stores the pick, and the history and the bar say which solution", async () => {
    const r = await store.resolve(target, "solution", "Built into Sales v8", sol);
    expect(r.status).toBe("ok");
    const issue = (r as { issue: ReturnType<typeof issues.at> & object }).issue;
    expect(issue).toMatchObject({ resolved_how: "solution", resolved_solution_id: sol.id });
    const events = await store.events(target);
    const resolved = events.at(-1)!;
    expect(resolved.detail).toMatchObject({ how: "solution", solution_id: sol.id, solution: sol.name, note: "Built into Sales v8" });
    expect(historyText(resolved as IssueEventRow, { step: () => undefined, person: () => undefined, source: () => undefined })).toBe("Marked resolved by solution “AI lead qualifier”. “Built into Sales v8”");
    expect(resolvedBar(issue, new Date("2026-10-10T00:00:00Z"), sol.name)).toMatch(/^Resolved .+ · by solution “AI lead qualifier” · Built into Sales v8$/);
  });

  it("still works without naming one (the old way), and a solution can't go with another way", async () => {
    expect((await store.resolve(target, "solution", null)).status).toBe("ok");
    expect((await store.events(target)).at(-1)!.detail).not.toHaveProperty("solution");
    const other = issues[1]!.id;
    expect((await store.resolve(other, "process_change", null, sol)).status).toBe("error");
  });

  it("reopening clears the pick; the history keeps its name", async () => {
    await store.resolve(target, "solution", null, sol);
    const back = await store.reopen(target);
    expect((back as { issue: { resolved_solution_id: string | null } }).issue.resolved_solution_id).toBeNull();
    expect((await store.events(target)).find((e) => e.kind === "resolved")!.detail).toMatchObject({ solution: sol.name });
  });

  it("the history words a verdict and a note on a solution", () => {
    const names = { step: () => undefined, person: () => undefined, source: () => undefined };
    const text = (d: object) => historyText({ kind: "edited", detail: d } as IssueEventRow, names);
    expect(text({ solution_verdict: { solution: "Lead scoring", verdict: "pass", was: null, notes_changed: false } })).toBe("Your verdict on “Lead scoring”: Pass.");
    expect(text({ solution_verdict: { solution: "Lead scoring", verdict: "fail", was: "pass", notes_changed: true } })).toBe("Your verdict on “Lead scoring”: Fail. Updated your note on “Lead scoring”.");
    expect(text({ solution_verdict: { solution: "Lead scoring", verdict: null, was: "fail", notes_changed: false } })).toBe("Cleared your verdict on “Lead scoring”.");
    expect(text({ solution_verdict: { solution: "Lead scoring", verdict: "pass", was: "pass", notes_changed: true } })).toBe("Updated your note on “Lead scoring”.");
    // A deleted solution (issue #182) leaves a line on each issue it was linked to.
    expect(text({ solution_deleted: { solution_id: "x", solution: "Lead scoring" } })).toBe("Deleted solution “Lead scoring”.");
    // Its only solution gone, the issue went back to Open in the same entry.
    expect(text({ from: "testing", to: "open", solution_deleted: { solution_id: "x", solution: "Lead scoring" } })).toBe("Deleted solution “Lead scoring”. Status Testing solutions to Open.");
  });
});

describe("the demo's solutions, in this tab", () => {
  it("keeps a verdict, notes and a new link", () => {
    const { solution: s } = addDemoSolution({
      name: "Fast audit",
      processId: NORTHBEAM_PROCESS_ID,
      baseRevisionId: live.revision.id,
      copy: solutionCopy(live),
      changedStepIds: [ids.audit],
      levers: [],
      stepChanges: [],
      links: [{ issueId: issueA!.id, autoVerdict: "pass", holdsPct: 90, autoNote: "ok" }],
    });
    expect(setDemoVerdict(s.id, issueA!.id, { verdict: "fail", notes: "Too slow in a downturn" })).toMatchObject({ user_verdict: "fail", user_notes: "Too slow in a downturn" });
    expect(setDemoVerdict(s.id, issueA!.id, { verdict: null })).toMatchObject({ user_verdict: null, user_notes: "Too slow in a downturn" });
    // A note on its own leaves the verdict as it is.
    setDemoVerdict(s.id, issueA!.id, { verdict: "pass" });
    expect(setDemoVerdict(s.id, issueA!.id, { notes: "Later" })).toMatchObject({ user_verdict: "pass", user_notes: "Later" });
    setDemoNotes(s.id, "Needs a trial");
    const added = addDemoLink(s.id, issueB!.id, { autoVerdict: "fail", holdsPct: 12, autoNote: "no" });
    expect(added).toMatchObject({ solution_id: s.id, issue_id: issueB!.id, auto_verdict: "fail", holds_pct: 12 });
    // Linking the same issue twice is refused, as the table's primary key does.
    expect(addDemoLink(s.id, issueB!.id, { autoVerdict: "pass", holdsPct: 1, autoNote: "" })).toBeNull();
    // An unchecked link carries no percentage.
    expect(addDemoLink(s.id, issues[2]!.id, { autoVerdict: null, holdsPct: 50, autoNote: "?" })).toMatchObject({ auto_verdict: null, holds_pct: null });
  });
});

describe("the sidebar", () => {
  it("has Solutions built, so nothing is marked soon", () => {
    const item = workspaceNav({ slug: "s", pathname: "/w/s/solutions", counts: {} })
      .flatMap((g) => g.items)
      .find((i) => i.key === "solutions");
    expect(item).toMatchObject({ href: "/w/s/solutions", active: true });
    expect(item!.soon).toBeUndefined();
  });
});

describe("(i) help on every control", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
  const sets = { SOLUTIONS_LIST_HELP, SOLUTION_PAGE_HELP };

  it("has a plain description and an example for each", () => {
    const all = [...Object.entries(SOLUTIONS_LIST_HELP), ...Object.entries(SOLUTION_PAGE_HELP), ["pick", RESOLVE_SOLUTION_HELP] as const];
    for (const [key, help] of all) {
      expect(help.description.length, key).toBeGreaterThan(20);
      expect(help.example.length, key).toBeGreaterThan(8);
      expect(`${help.description} ${help.example}`, key).not.toMatch(/\b(RLS|jsonb|payload|enum|schema|FK)\b/);
    }
  });

  it("shows an (i) beside each, in the screens that use it", () => {
    const src = [read("components/solutions/solution-cards.tsx"), read("components/solutions/solutions-list.tsx"), read("components/solutions/new-solution.tsx"), read("components/solutions/solution-page.tsx")].join("\n");
    for (const [name, set] of Object.entries(sets)) {
      for (const key of Object.keys(set)) {
        // Spread into an (i), or handed to the placeholder sections, which draw one.
        const used = src.includes(`{...${name}.${key}}`) || src.includes(`help={${name}.${key}}`);
        expect(used, `${name}.${key} has no (i)`).toBe(true);
      }
    }
    expect(read("components/issues/resolve-dialog.tsx")).toContain("{...RESOLVE_SOLUTION_HELP}");
  });

  it("says plainly that the button starts a new solution from live, not this solution's changes", () => {
    const h = newOnProcessHelp("Sales");
    expect(h.description).toBe("Starts a new solution from the live version of Sales. This solution's changes are not carried over yet; that comes later.");
    expect(read("components/solutions/solution-cards.tsx") + read("components/solutions/solution-page.tsx")).not.toMatch(/✎ Open in Editor/);
  });

  it("names who built it: you, the person linked to the member, a team member, or someone", () => {
    expect(builtBy("u2", "u1", false, { u2: "Rosa Diaz" })).toBe("Rosa Diaz");
    expect(builtBy("u3", "u1", false, { u2: "Rosa Diaz" })).toBe("A team member");
    expect(builtBy("u1", "u1", false, { u1: "Austin" })).toBe("You");
    expect(builtBy(null, "u1", false, {})).toBe("Someone");
  });

  it("the Resolve help no longer says the pick isn't recorded", () => {
    expect(RESOLVE_HELP.solution.description).not.toMatch(/does not record which one/);
    expect(RESOLVE_HELP.solution.description).toMatch(/which solution/);
  });

  it("the Solution page has only the header, the notes and sources, and the two maps (Q12, D44; QA round 2)", () => {
    const page = read("components/solutions/solution-page.tsx");
    for (const t of ["Open in editor", "Notes and sources", "data-edited", "Solutions never change the live map", "<SolutionMaps", "<EditableText", "<SolutionStatusMenu"]) expect(page).toContain(t);
    // No generated list of changes, no Built by and no Sandbox button: the notes say what it changes (QA round 2).
    for (const t of ["What it changes", "changeLines", "Built by", "Try it in the Sandbox"]) expect(page).not.toContain(t);
    expect(page).not.toContain("AdoptSolution");
    // The measures, the revenue chart, the stress test and the per-issue verdict cards were taken off.
    for (const t of ["Measures", "MRR over time", "Market stress test", "SolutionCompare", "SolvesCard", "VerdictWord", "saveSolutionVerdict"]) expect(page).not.toContain(t);
    const cards = read("components/solutions/solution-cards.tsx");
    for (const t of ["Solves", "Open", "✎ New solution on", "Not linked to an issue yet", "Changes"]) expect(cards).toContain(t);
    expect(read("components/solutions/new-solution.tsx")).toContain("✎ New solution");
  });

  it("the page's removed code is gone: no stress test, no comparison component, no stress worker", () => {
    for (const gone of ["components/solutions/solution-compare.tsx", "lib/solutions/stress.ts", "lib/solutions/use-stress.ts", "workers/stress.worker.ts"]) {
      expect(() => read(gone), gone).toThrow();
    }
  });

  it("puts no first-run chip on the two maps: they draw no run's numbers (issue #44)", () => {
    const maps = read("components/solutions/solution-maps.tsx");
    expect(maps).toContain("<ProcessCanvas");
    expect(maps).not.toMatch(/\bcomputing[=:{]/);
    expect(maps).not.toMatch(/\bresult=\{/);
    // Shared open state between the two maps.
    expect(maps).toMatch(/expanded=\{expanded\}/);
    expect(maps).toMatch(/onExpandedChange=\{setExpanded\}/);
  });
});
