import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every field on the Editor screen has an (i) with a plain-English description and an example (issue #104, D34).
// The step inspector's fields take a `help` prop and the other panels use <Help>; this reads the source so a new
// control without one, or one worded in jargon, fails here.

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

/** The opening tags of the fields in a source file, as written. */
function fieldTags(source: string): string[] {
  const out: string[] = [];
  const open = /<(TextField|NumberField|SelectField)\b/g;
  for (let m = open.exec(source); m; m = open.exec(source)) {
    // The tag ends at the first `>` that isn't part of `=>` or inside braces.
    let depth = 0;
    let i = m.index;
    for (; i < source.length; i++) {
      const c = source[i]!;
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && source[i - 1] !== "=") break;
    }
    out.push(source.slice(m.index, i + 1));
  }
  return out;
}

/** Every `<Help ... />` in a source file, as written (its tag runs to the `/>`). */
function helpTags(source: string): string[] {
  return source.match(/<Help\b[\s\S]*?\/>/g) ?? [];
}

/** The words a person reads: a field's label and its (i) text, not the code around them. */
const words = (tag: string) =>
  [...tag.matchAll(/(?:label|description|example):\s*"([^"]*)"|(?:label|description|example)="([^"]*)"/g)].map((m) => m[1] ?? m[2]).join(" ");

const JARGON = /\b(SLA|WIP|CV|Mean|lognormal|triangular|constant|distribution|warm-up|replications?)\b/i;

describe("the Editor's inspector", () => {
  const source = read("components/step-inspector.tsx");
  const tags = fieldTags(source);

  it("finds the inspector's fields", () => {
    expect(tags.length).toBeGreaterThanOrEqual(15);
  });

  it("gives every field an (i) with a description and an example", () => {
    const missing = tags
      .filter((t) => !/help=\{\{/.test(t) || !/description:\s*[^,\s]/.test(t) || !/example:\s*[^,\s]/.test(t))
      .map((t) => /label="([^"]+)"/.exec(t)?.[1] ?? t.slice(0, 60));
    expect(missing).toEqual([]);
  });

  it("uses plain words, not jargon, in its labels, options and (i) text", () => {
    for (const tag of tags) expect(words(tag), words(tag)).not.toMatch(JARGON);
    // A time is "Usually" and "It varies", not a choice of patterns (brainstorm round 2, item 10).
    expect(source).not.toMatch(/DIST_OPTIONS|Time pattern|How much it varies/);
    // The note under the fields too.
    expect(source).not.toMatch(/warm-up/i);
  });
});

describe("every (i) on the Editor screen", () => {
  const files = [
    "components/editor/palette.tsx",
    "components/editor/inspector.tsx",
    "components/editor/decision-panel.tsx",
    "components/editor/editor-bar.tsx",
    "components/editor/issue-area.tsx",
    "components/solutions/process-solutions.tsx",
    "components/evidence.tsx",
    "components/blocks/block-library.tsx",
  ];

  it("has a label, a description and an example, each on its own", () => {
    for (const file of files) {
      const tags = helpTags(read(file));
      expect(tags.length, file).toBeGreaterThan(0);
      for (const tag of tags) {
        const where = `${file}: ${tag.slice(0, 60)}`;
        expect(tag, where).toMatch(/label=/);
        expect(tag, where).toMatch(/description=\{?"[^"]{15,}"/);
        expect(tag, where).toMatch(/example=\{?"[^"]{8,}"/);
      }
    }
  });

  it("keeps each named (i), so deleting one is caught", () => {
    const expected: Record<string, string[]> = {
      "components/editor/inspector.tsx": ["What they achieve", "First step", "Save this group as a block"],
      "components/editor/decision-panel.tsx": ["Branches", "Goes to"],
      // The company map's Add has its own words (QA round 2, item 7: both maps share one palette).
      "components/editor/palette.tsx": ["Add", "Add", "Groups", "Blocks", "Insert", "Replace selected"],
      "components/editor/editor-bar.tsx": ["Save to library", "Save solution", "Block name", "Description", "Solution name"],
      "components/editor/issue-area.tsx": ["Issue area"],
      // "New solution" moved to the shared button (Q12), which draws its (i) from SOLUTIONS_LIST_HELP.
      "components/solutions/process-solutions.tsx": ["Build solution"],
    };
    for (const [file, labels] of Object.entries(expected)) {
      const tags = helpTags(read(file));
      expect(tags.map((t) => /label="([^"]+)"/.exec(t)?.[1]), file).toEqual(labels);
    }
  });

  it("puts one beside each heading of the palette, as the prototype has them (Add twice: a process's and the company map's), and one beside the block buttons", () => {
    expect(helpTags(read("components/editor/palette.tsx"))).toHaveLength(6);
  });

  it("cites a source with an (i) on every field of the form", () => {
    const form = helpTags(read("components/evidence.tsx"));
    for (const label of ["Evidence", "Value", "Source", "Speaker", "Where", "Quote", "The value they stated"]) {
      expect(form.some((t) => t.includes(`label="${label}"`)), label).toBe(true);
    }
  });
});

describe("every control of the block library (issue #116)", () => {
  it("names its (i)s: the library's New block and its column headings", () => {
    const tags = helpTags(read("components/blocks/block-library.tsx"));
    expect(tags.map((t) => /label="([^"]+)"/.exec(t)?.[1])).toEqual(["New block", "Steps", "Who does it", "Time per run", "Automatable", "Used in"]);
  });

  it("marks no block as made by AI: in-app AI and its solution ideas are gone (cut list items 1 and 2)", () => {
    expect(read("components/blocks/block-library.tsx")).not.toMatch(/\bAI\b/);
    expect(read("components/editor/palette.tsx")).not.toMatch(/"AI"|=== "ai"/);
  });

  it("has a button for each thing the block (i)s describe", () => {
    const palette = read("components/editor/palette.tsx");
    for (const button of ["Insert", "Replace selected"]) expect(palette).toContain(button);
    expect(read("components/editor/inspector.tsx")).toContain("Save this group as a block");
    expect(read("components/editor/editor-bar.tsx")).toContain("Save to library");
  });

  it("uses plain words, not jargon, in the block (i)s", () => {
    for (const file of ["components/blocks/block-library.tsx", "components/editor/palette.tsx", "components/editor/inspector.tsx", "components/editor/editor-bar.tsx"]) {
      for (const tag of helpTags(read(file))) expect(words(tag), words(tag)).not.toMatch(JARGON);
    }
  });
});

describe("every control of solution mode (issue #114)", () => {
  it("has an (i) beside the name, the save, the issue area and the ways in, and no automatic verdict (QA round 2)", () => {
    const labels = (file: string) => helpTags(read(file)).map((t) => /label="([^"]+)"/.exec(t)?.[1]);
    expect(labels("components/editor/editor-bar.tsx")).toEqual(expect.arrayContaining(["Solution name", "Save solution"]));
    expect(labels("components/editor/issue-area.tsx")).toEqual(["Issue area"]);
    // No Simulate in the Editor (brainstorm round 2, item 7), so no footer and no automatic verdict.
    expect(() => read("components/editor/simulate-footer.tsx")).toThrow();
    expect(labels("components/editor/editor-bar.tsx")).not.toContain("Simulate");
    expect(labels("components/solutions/process-solutions.tsx")).toEqual(["Build solution"]);
    expect(read("components/solutions/new-solution.tsx")).toContain("{...SOLUTIONS_LIST_HELP.newSolution}");
    // The (i) on the process page's Solutions heading was removed on purpose (QA wave 1); its two buttons above keep theirs.
  });

  it("has a button for each thing those (i)s describe", () => {
    expect(read("components/editor/editor-bar.tsx")).toContain("Save solution");
    expect(read("components/solutions/process-solutions.tsx")).toContain("<NewSolutionButton");
    expect(read("components/solutions/new-solution.tsx")).toContain("✎ New solution");
    expect(read("components/solutions/process-solutions.tsx")).toContain("✎ Build solution");
  });

  it("uses plain words, not jargon, in the solution (i)s", () => {
    for (const file of ["components/editor/issue-area.tsx", "components/solutions/process-solutions.tsx", "components/editor/editor-bar.tsx"]) {
      for (const tag of helpTags(read(file))) expect(words(tag), words(tag)).not.toMatch(JARGON);
    }
  });
});
