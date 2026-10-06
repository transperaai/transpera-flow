import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockProblem } from "@/lib/blocks/blocks";
import { applyEdit } from "@/lib/editor/ops";
import { diffBundles } from "@/lib/drafts/diff";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockMap } from "@/components/blocks/block-map";
import { buildIdeaHref, ideaSeed, ideaToBlock, MAX_IDEA_STEPS, placeIdea, readIdea } from "@/lib/suggestions/idea";
import { demoProposals } from "@/lib/suggestions/demo";
import { demoBundle } from "@/lib/sources/demo";
import { solutionEditorHref } from "@/lib/solutions/links";
import { northbeamIssues, northbeamStepIds, type ProposalRow, type SolutionIdeaPayload } from "@transpera-flow/db";
import { describeProposal, SUGGESTIONS_HELP } from "@/lib/suggestions/proposals";

// Solution ideas as maps and as steps in the Editor (issue #117, A52 slice 2): the idea becomes a block the card draws and the
// Editor places, in place of the step it would replace; Build it opens the Editor on the issue's process with the idea named.

const idea = demoProposals().find((p) => p.kind === "solution_idea")!;
const payload = idea.payload as SolutionIdeaPayload;
const bundle = demoBundle();

describe("an idea as a block", () => {
  it("has one step per proposed step, left to right, joined in order, and is a block the Editor accepts", () => {
    const block = ideaToBlock(payload);
    expect(blockProblem(block)).toBeNull();
    expect(block.steps.map((s) => s.name)).toEqual(["Partner lead arrives", "Book discovery call", "Quick check by AI"]);
    expect(block.steps.map((s) => s.x)).toEqual([0, 240, 480]);
    expect(block.edges.map((e) => [e.from_step_id, e.to_step_id])).toEqual([
      ["s1", "s2"],
      ["s2", "s3"],
    ]);
    expect(block.entry_step_id).toBe("s1");
  });

  it("makes an AI step a quick task marked as an assumption, gives a named role its id, and turns a start or end step into a task", () => {
    const block = ideaToBlock(
      { steps: [{ key: "a", name: "Score", ai: true, role: "sales" }, { key: "b", name: "End here", kind: "end" }, { key: "c", name: "Wait a day", kind: "wait" }] },
      [{ id: "role-1", name: "Sales" }],
    );
    const [a, b, c] = block.steps;
    expect(a).toMatchObject({ kind: "task", work_hours: 0.1, tool: "AI", assumption: true, role_id: "role-1" });
    expect(b).toMatchObject({ kind: "task", outcome: null });
    expect(c).toMatchObject({ kind: "wait", wait_hours: 8, work_hours: 0 });
    expect(blockProblem(block)).toBeNull();
  });

  it("drops an edge to a step that isn't there, and chains the steps when it gives none", () => {
    const edges = ideaToBlock({ steps: [{ key: "a", name: "A" }, { key: "b", name: "B" }], edges: [{ from: "a", to: "zzz" }, { from: "a", to: "b" }] }).edges;
    expect(edges).toHaveLength(1);
    expect(ideaToBlock({ steps: [{ key: "a", name: "A" }, { key: "b", name: "B" }, { key: "c", name: "C" }] }).edges).toHaveLength(2);
  });
});

describe("placing an idea in the solution's copy of the map", () => {
  it("replaces the step it names with the AI's steps, joined to what led in and out of it", () => {
    const placed = placeIdea(bundle, ideaSeed(idea, bundle.roles));
    expect(placed.note).toContain("The AI's steps are placed. Adjust them, simulate, then save.");
    const after = applyEdit(bundle, placed.edit!);
    expect(after.steps.some((s) => s.id === northbeamStepIds.qualify)).toBe(false);
    const group = after.steps.find((s) => s.id === placed.id)!;
    expect(group).toMatchObject({ kind: "group", name: idea.title });
    const inside = after.steps.filter((s) => s.parent_step_id === group.id).map((s) => s.name);
    expect(inside).toEqual(expect.arrayContaining(["Partner lead arrives", "Book discovery call", "Quick check by AI"]));
    // Whatever led into Qualify lead now leads into the group, and what it led to is led to from the group.
    const led = bundle.edges.filter((e) => e.to_step_id === northbeamStepIds.qualify).map((e) => e.from_step_id);
    expect(after.edges.filter((e) => e.to_step_id === group.id).map((e) => e.from_step_id)).toEqual(led);
    const next = bundle.edges.filter((e) => e.from_step_id === northbeamStepIds.qualify).map((e) => e.to_step_id);
    expect(after.edges.filter((e) => e.from_step_id === group.id).map((e) => e.to_step_id)).toEqual(next);
    // Against live it shows as added (the new steps) and removed (the replaced one), which is what a solution saves.
    const changes = diffBundles(bundle, after);
    expect(changes.list.length).toBeGreaterThan(0);
  });

  it("puts the steps at the end, and says so, when the idea names nothing it can replace", () => {
    const none = { ...ideaSeed(idea, bundle.roles), replaces: [] };
    const placed = placeIdea(bundle, none);
    expect(placed.note).toContain("sit at the end");
    const after = applyEdit(bundle, placed.edit!);
    expect(after.steps.some((s) => s.id === northbeamStepIds.qualify)).toBe(true);
    expect(after.steps.some((s) => s.id === placed.id)).toBe(true);
    // A start step can't be replaced either: the same.
    expect(placeIdea(bundle, { ...none, replaces: [northbeamStepIds.start] }).note).toContain("sit at the end");
  });

  it("says when it names more than one step to replace", () => {
    const placed = placeIdea(bundle, { ...ideaSeed(idea, bundle.roles), replaces: [northbeamStepIds.qualify, northbeamStepIds.discovery] });
    expect(placed.note).toContain("The first is replaced; the others are still there.");
  });

  it("says so, and places nothing, when the idea has no usable steps", () => {
    const placed = placeIdea(bundle, { id: "x", title: "Empty", block: { steps: [], edges: [], entry_step_id: null }, replaces: [], levers: [], leverNotes: [] });
    expect(placed).toMatchObject({ edit: null, id: null });
    expect(placed.note).toBe("The AI's steps weren't placed: it has no usable steps. The map is a plain copy of the live one, so you can build the solution yourself.");
  });

  it("says so when the steps can't be placed", () => {
    const bad = ideaToBlock({ steps: [{ key: "a", name: "A" }] });
    bad.steps[0]!.parent_step_id = "nowhere";
    expect(placeIdea(bundle, { id: "x", title: "Bad", block: bad, replaces: [], levers: [], leverNotes: [] })).toMatchObject({ edit: null, note: expect.stringContaining("can't be placed") });
  });
});

// A stored payload can be anything (the database only checks that steps is an array), and it must never break a page.
describe("a malformed idea", () => {
  const malformed: [string, unknown][] = [
    ["steps: [null]", { steps: [null] }],
    ["steps: [1]", { steps: [1] }],
    ["steps: [[]]", { steps: [[]] }],
    ["steps: 'abc'", { steps: "abc" }],
    ["edges: {}", { steps: [{ key: "a", name: "A" }], edges: {} }],
    ["edges: [null]", { steps: [{ key: "a", name: "A" }], edges: [null] }],
    ["name: null", { steps: [{ key: "a", name: null }] }],
    ["key: 5", { steps: [{ key: 5, name: "A" }] }],
    ["role: 7", { steps: [{ key: "a", name: "A", role: 7 }] }],
    ["replaces_step_ids: 'abc'", { steps: [{ key: "a", name: "A" }], replaces_step_ids: "abc" }],
    ["no payload at all", null],
  ];

  it("reads without throwing, and ideaToBlock, ideaSeed and placeIdea carry on", () => {
    for (const [label, payload] of malformed) {
      expect(() => readIdea(payload), label).not.toThrow();
      expect(() => ideaToBlock(payload, bundle.roles), label).not.toThrow();
      const seed = ideaSeed({ id: "i", title: "T", payload } as ProposalRow, bundle.roles);
      expect(() => placeIdea(bundle, seed), label).not.toThrow();
      expect(placeIdea(bundle, seed).note.length, label).toBeGreaterThan(0);
      // The card's text and the map read it too.
      expect(() => describeProposal({ ...idea, payload } as ProposalRow, { processes: {}, steps: {}, issues: {} }), label).not.toThrow();
      expect(() => renderToStaticMarkup(createElement(BlockMap, { block: ideaToBlock(payload), label: "x" })), label).not.toThrow();
    }
  });

  it("keeps what is usable: object steps only, a name that is a string, a unique key, string ids", () => {
    const r = readIdea({
      steps: [null, { key: "a", name: "First", role: "Sales" }, { key: "a", name: null }, 3, { key: 9, name: 12, role: {} }],
      edges: [null, { from: "a", to: "a" }, { from: "a", to: "zzz" }, { from: "a", to: "s3" }, { from: 1, to: 2 }],
      replaces_step_ids: ["x", 4, null, "y"],
    });
    expect(r.steps.map((s) => s.name)).toEqual(["First", "Step 2", "12"]);
    expect(r.steps.map((s) => s.key)).toEqual(["a", "s2", "s3"]);
    expect(r.steps[0]).toMatchObject({ key: "a", role: "Sales" });
    expect(r.steps[2]!.role).toBeUndefined();
    // Self-loops, edges to steps that aren't there and edges that aren't pairs of ids are dropped.
    expect(r.edges).toEqual([{ from: "a", to: "s3" }]);
    expect(r.replaces).toEqual(["x", "y"]);
  });

  it("chains the steps when edges aren't a list, and uses none when it is an empty list", () => {
    const two = [{ key: "a", name: "A" }, { key: "b", name: "B" }];
    expect(ideaToBlock({ steps: two, edges: {} }).edges).toHaveLength(1);
    expect(ideaToBlock({ steps: two, edges: [] }).edges).toHaveLength(0);
  });

  it("caps an idea at 30 steps", () => {
    const many = { steps: Array.from({ length: 45 }, (_, i) => ({ key: `k${i}`, name: `S${i}` })) };
    expect(readIdea(many).steps).toHaveLength(MAX_IDEA_STEPS);
    expect(ideaToBlock(many).steps).toHaveLength(30);
  });

  it("the map draws what it can of a bad block instead of failing", () => {
    const bad = { steps: [null, { id: "a", name: null, x: "nope", y: 0 }, { id: "b", name: 5, x: 0, y: 0 }], edges: [null, { from_step_id: "b", to_step_id: "zz" }], entry_step_id: null } as never;
    expect(() => renderToStaticMarkup(createElement(BlockMap, { block: bad, label: "x" }))).not.toThrow();
    expect(() => renderToStaticMarkup(createElement(BlockMap, { block: {} as never, label: "x" }))).not.toThrow();
  });
});

describe("Build it", () => {
  const issue = northbeamIssues().find((i) => i.id === idea.issue_id)!;

  it("opens the Editor in solution mode on the issue's process, for that issue, with the idea and the way back", () => {
    const href = buildIdeaHref("/w/acme", idea, { processId: issue.process_id }, "/w/acme/suggestions")!;
    expect(href).toBe(solutionEditorHref("/w/acme", issue.process_id!, { issueId: idea.issue_id, idea: idea.id, from: "/w/acme/suggestions" }));
    const q = new URL(href, "http://x").searchParams;
    expect(href).toMatch(new RegExp(`^/w/acme/p/${issue.process_id}/edit\\?`));
    expect([q.get("mode"), q.get("issue"), q.get("idea"), q.get("from")]).toEqual(["solution", idea.issue_id, idea.id, "/w/acme/suggestions"]);
    expect(buildIdeaHref("/demo", idea, { processId: issue.process_id }, "/demo/suggestions")).toMatch(/^\/demo\/edit\?mode=solution&issue=.*&idea=.*/);
  });

  it("has nowhere to open when the issue names no process, or the idea is for no issue", () => {
    expect(buildIdeaHref("/w/acme", idea, { processId: null }, "/x")).toBeNull();
    expect(buildIdeaHref("/w/acme", idea, undefined, "/x")).toBeNull();
    expect(buildIdeaHref("/w/acme", { ...idea, issue_id: null } as ProposalRow, { processId: "p" }, "/x")).toBeNull();
  });
});

describe("the (i) help for ideas (issue #117)", () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  it("explains Build it and the map, with an example each, and shows them on the card", () => {
    for (const key of ["buildIt", "ideaMap", "dismiss", "ideas"] as const) {
      expect(SUGGESTIONS_HELP[key].description.length, key).toBeGreaterThan(30);
      expect(SUGGESTIONS_HELP[key].example.length, key).toBeGreaterThan(10);
    }
    const card = read("components/idea-card.tsx");
    for (const key of ["buildIt", "ideaMap", "dismiss"]) expect(card).toContain(`SUGGESTIONS_HELP.${key}`);
    expect(card).toContain("✎ Build it");
  });

  it("the Suggestions blurb follows the prototype now that Build it exists", () => {
    expect(read("components/proposals-review.tsx")).toContain("Build one to open the Editor with the AI&apos;s steps already placed; saving it turns it into a real solution.");
  });
});
