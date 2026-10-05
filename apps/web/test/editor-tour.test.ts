import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dismiss, isDismissed, presentSteps, resolveTarget, tourKey, tourSteps, tourVariant, type TourStorage } from "../src/lib/editor/tour";

// The Editor's written tour (issue #176, B18): its steps, their words, and the "shown once, per user" rule. The tour in a real
// browser, on the real Editor, is editor-tour-browser.test.ts.

const memory = (): TourStorage => {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("the tour's steps", () => {
  it("has 8 steps for a process, one for each area the issue names, in the order a person works", () => {
    expect(tourSteps("process").map((s) => s.id)).toEqual(["palette", "canvas", "inspector", "checklist", "draft", "simulate", "publish", "history"]);
  });

  it("has a shorter tour for the company map, which has nothing to simulate", () => {
    const company = tourSteps("company").map((s) => s.id);
    expect(company).toEqual(["palette", "canvas", "inspector", "draft", "publish"]);
    expect(company.length).toBeLessThan(tourSteps("process").length);
    expect(tourVariant(true)).toBe("company");
    expect(tourVariant(false)).toBe("process");
  });

  it("says in plain words what each area is for, with a short body and no jargon (D34)", () => {
    for (const variant of ["process", "company"] as const) {
      for (const s of tourSteps(variant)) {
        expect(s.title.length, s.id).toBeGreaterThan(3);
        expect(s.body.length, s.id).toBeGreaterThan(40);
        expect(s.body.length, s.id).toBeLessThan(260);
        expect(`${s.title} ${s.body}`, s.id).not.toMatch(/\b(RLS|jsonb|payload|enum|schema|provenance|revision|API|Monte Carlo|lever)\b/i);
      }
    }
    // The canvas step names the three things the issue asks for.
    const canvas = tourSteps("process").find((s) => s.id === "canvas")!.body;
    expect(canvas).toMatch(/Drag a step to move/);
    expect(canvas).toMatch(/connect/);
    expect(canvas).toMatch(/Double-click/);
  });

  it("points every step at an element the Editor really draws", () => {
    const editor = ["components/editor/editor-bar.tsx", "components/editor/editor-view.tsx", "components/simulation-gaps.tsx"].map(read).join("\n");
    for (const step of [...tourSteps("process"), ...tourSteps("company")]) {
      // Each step needs at least one selector that is in the source; the others are fallbacks.
      const found = step.target.some((selector) => {
        const data = /^\[(data-[\w-]+)(?:=([\w-]+))?\]$/.exec(selector);
        if (data) return editor.includes(data[1]!) && (!data[2] || editor.includes(`"${data[2]}"`));
        const aside = /^aside\[aria-label="(\w+)"\]$/.exec(selector);
        return !!aside && editor.includes(`<aside aria-label="${aside[1]}"`);
      });
      expect(found, `${step.id}: ${step.target.join(" | ")}`).toBe(true);
    }
  });

  it("tries a step's selectors in order, and drops a step that points at nothing", () => {
    const root = (present: string[]) => ({ querySelector: (s: string) => (present.includes(s) ? ({} as Element) : null) });
    const checklist = tourSteps("process").find((s) => s.id === "checklist")!;
    expect(resolveTarget(checklist, root(["[data-missing-for-simulation]", 'aside[aria-label="Inspector"]']))).not.toBeNull();
    expect(resolveTarget(checklist, root(['aside[aria-label="Inspector"]']))).not.toBeNull();
    expect(resolveTarget(checklist, root([]))).toBeNull();
    // A block's Editor has no draft chip, Simulate or Publish.
    const block = root(['aside[aria-label="Palette"]', "[data-tour=canvas]", 'aside[aria-label="Inspector"]']);
    expect(presentSteps("process", block).map((s) => s.id)).toEqual(["palette", "canvas", "inspector", "checklist"]);
  });
});

describe("shown once, per user", () => {
  it("is not dismissed until it is, and then stays dismissed", () => {
    const storage = memory();
    expect(isDismissed(storage, "u1", "process")).toBe(false);
    dismiss(storage, "u1", "process");
    expect(isDismissed(storage, "u1", "process")).toBe(true);
  });

  it("is kept per user, and per tour: the company map's is its own", () => {
    const storage = memory();
    dismiss(storage, "u1", "process");
    expect(isDismissed(storage, "u2", "process")).toBe(false);
    expect(isDismissed(storage, "u1", "company")).toBe(false);
    expect(isDismissed(storage, null, "process")).toBe(false);
    dismiss(storage, null, "process");
    expect(isDismissed(storage, null, "process")).toBe(true);
    expect(tourKey("u1", "process")).not.toBe(tourKey("u2", "process"));
    expect(tourKey(null, "company")).toContain("demo");
  });

  it("copes with storage that is missing or throws: the tour is simply shown", () => {
    const broken: TourStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(isDismissed(null, "u1", "process")).toBe(false);
    expect(isDismissed(broken, "u1", "process")).toBe(false);
    expect(() => dismiss(broken, "u1", "process")).not.toThrow();
    expect(() => dismiss(null, "u1", "process")).not.toThrow();
  });
});
