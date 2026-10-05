import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every setting, lever and rule on the process page has an (i) with a description and an example (issue #103). Checked
// on the source: each of these labels must be given to a <Help> with both texts.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

const EXPECT: Record<string, string[]> = {
  "components/process-page.tsx": ["Process rating"],
  "components/utilisation-bars.tsx": ["How busy each role is"],
  "components/horizon-picker.tsx": ["Projection"],
};

describe("process page help", () => {
  for (const [file, labels] of Object.entries(EXPECT)) {
    it(`${file} explains its controls`, () => {
      const text = read(file);
      for (const label of labels) {
        const at = text.indexOf(`label="${label}"`);
        expect(at, `${label} has no <Help>`).toBeGreaterThan(-1);
        const tag = text.slice(at, at + 700);
        expect(tag).toMatch(/description="/);
        expect(tag).toMatch(/example="/);
      }
    });
  }

  it("only the non-obvious things on the process page keep an (i): the map colours and the process rating", () => {
    const text = read("components/process-page.tsx");
    expect(text).toContain('label: "Map colours"');
    expect((text.match(/<Help\b/g) ?? []).length).toBeLessThanOrEqual(2);
    for (const label of ["First principles", "Insights", "Issues", "Solutions", "Sources"]) expect(text).not.toContain(`label: "${label}"`);
  });

  it("an opened insight keeps at most two (i)s: the cost estimate and Dismiss; the list and rows have none", () => {
    const text = read("components/insights.tsx");
    for (const label of ["Cost per month", "Dismiss"]) {
      const at = text.indexOf(`label: "${label}"`);
      expect(at, `${label} has no help text`).toBeGreaterThan(-1);
      const entry = text.slice(at, at + 700);
      expect(entry).toMatch(/description:/);
      expect(entry).toMatch(/example:/);
    }
    for (const key of ["cost", "dismiss"]) expect(text).toContain(`<Help {...INSIGHT_HELP.${key}} />`);
    expect((text.match(/<Help\b/g) ?? []).length).toBe(2);
  });

  it("levers bring their own (i); the Overview's health cards (B15) keep to none, as QA wave 1 left the Overview", () => {
    expect(read("components/overview/health-cards.tsx")).not.toContain("<Help");
    expect(read("components/lever-panel.tsx")).toContain("<Help");
  });
});
