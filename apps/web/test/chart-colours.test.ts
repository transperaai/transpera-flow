import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PURPOSES } from "@transpera-flow/db";
import {
  BASELINE_COLOUR,
  CATEGORICAL,
  categoricalColour,
  colourFor,
  departmentColours,
  DIVERGING,
  IDLE_COLOUR,
  labelOn,
  OTHER_COLOUR,
  PURPOSE_COLOURS,
  purposeColour,
  SEQUENTIAL,
  stableOrder,
} from "@/lib/chart-colours";

// One chart palette for the whole app (styles/tokens.css), picked the same way everywhere.

describe("the categorical slots", () => {
  it("are eight, in a fixed order, then fold into Other instead of cycling", () => {
    expect(CATEGORICAL).toHaveLength(8);
    expect(new Set(CATEGORICAL).size).toBe(8);
    expect(categoricalColour(0)).toBe("var(--cat-1)");
    expect(categoricalColour(7)).toBe("var(--cat-8)");
    expect(categoricalColour(8)).toBe(OTHER_COLOUR);
    expect(categoricalColour(-1)).toBe(OTHER_COLOUR);
  });

  it("colour an entity by its place in a stable list, so a filter never repaints the others", () => {
    const all = stableOrder(["Sales", "Onboarding", "Delivery", "Onboarding"]);
    expect(all).toEqual(["Delivery", "Onboarding", "Sales"]);
    const before = colourFor("Sales", all);
    // The view drops Delivery, and Sales is now the biggest: its colour is the same.
    expect(colourFor("Sales", all)).toBe(before);
    expect(colourFor("Missing", all)).toBe(OTHER_COLOUR);
  });

  it("give departments fixed slots by name", () => {
    const a = departmentColours([{ id: "p", name: "Performance" }, { id: "o", name: "Organic" }]);
    const b = departmentColours([{ id: "o", name: "Organic" }, { id: "p", name: "Performance" }]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get("o")).toBe("var(--cat-1)");
  });
});

describe("purposes", () => {
  const keys = DEFAULT_PURPOSES.map((p) => p.key);

  it("keep 'Moves the client's job forward' on slot 1 (the brand teal) and every default on its own slot", () => {
    expect(purposeColour("client_job", keys)).toBe("var(--cat-1)");
    const slots = keys.map((k) => purposeColour(k, keys));
    expect(new Set(slots).size).toBe(keys.length);
    expect(slots.every((s) => (CATEGORICAL as readonly string[]).includes(s))).toBe(true);
  });

  it("never draw Fixing in a status colour", () => {
    expect(PURPOSE_COLOURS.fixing).not.toMatch(/warn|crit|good|rate-/);
  });

  it("give an added purpose the slot of a removed default, else Other; Not set is Other and Idle the idle neutral", () => {
    const withAdded = [...keys, "c0000000a"];
    expect(purposeColour("c0000000a", withAdded)).toBe(OTHER_COLOUR);
    const removedRequired = [...keys.filter((k) => k !== "required"), "c0000000a"];
    expect(purposeColour("c0000000a", removedRequired)).toBe(PURPOSE_COLOURS.required);
    expect(purposeColour("not_set", keys)).toBe(OTHER_COLOUR);
    expect(purposeColour("idle", keys)).toBe(IDLE_COLOUR);
  });
});

describe("text and the other jobs", () => {
  it("puts white on a categorical fill and the text colour on a neutral one", () => {
    expect(labelOn(CATEGORICAL[2])).toBe("var(--on-series)");
    expect(labelOn(OTHER_COLOUR)).toBe("var(--fg)");
  });

  it("has a single-hue sequential ramp, a diverging pair and a baseline, all defined in both themes", () => {
    const css = readFileSync(join(__dirname, "../src/styles/tokens.css"), "utf8");
    const names = [...CATEGORICAL, ...SEQUENTIAL, DIVERGING.neg, DIVERGING.mid, DIVERGING.pos, BASELINE_COLOUR, OTHER_COLOUR].map((v) => v.slice(4, -1));
    const blocks = css.split(/@media \(prefers-color-scheme: dark\)|:root\[data-theme="dark"\]/);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) for (const n of names) expect(block, n).toContain(`${n}:`);
    for (let i = 1; i <= 5; i++) expect(css).toMatch(new RegExp(`--seq-${i}: oklch\\([\\d.]+ [\\d.]+ 222\\)`));
  });
});
