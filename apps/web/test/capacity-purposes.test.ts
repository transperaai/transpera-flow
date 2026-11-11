import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { capacitySetupFromModel, DEFAULT_PURPOSES, timeToServe } from "@transpera-flow/db";
import { capacityModel } from "@transpera-flow/engine";
import { namedPurposeParts, PURPOSE_NOT_SET, PURPOSE_PALETTE, purposeColours } from "@/lib/capacity/purposes";
import { TimeToServe } from "@/components/capacity/capacity-view";

// The Capacity page's "time to serve" bars name their segments by the workspace's purposes, not by the raw keys ("client_job").

describe("namedPurposeParts", () => {
  it("names each key by the workspace's category, largest first", () => {
    const parts = namedPurposeParts([{ name: "required", hours: 2 }, { name: "client_job", hours: 6 }], DEFAULT_PURPOSES);
    expect(parts.map((p) => [p.name, p.value])).toEqual([["Moves the client's job forward", 6], ["Required", 2]]);
    expect(parts.map((p) => p.key)).toEqual(parts.map((p) => p.name));
  });

  it("uses a renamed category's new name", () => {
    const renamed = DEFAULT_PURPOSES.map((p) => (p.key === "client_job" ? { ...p, name: "Core delivery" } : p));
    expect(namedPurposeParts([{ name: "client_job", hours: 3 }], renamed)).toEqual([{ key: "Core delivery", name: "Core delivery", value: 3 }]);
  });

  it("says Not set for an unknown key, with one segment for all of them, and keeps Hand-holding by name", () => {
    const parts = namedPurposeParts([{ name: "gone_key", hours: 1 }, { name: "Other", hours: 2 }, { name: "Hand-holding", hours: 4 }, { name: "winning", hours: 0.5 }], DEFAULT_PURPOSES);
    expect(parts.map((p) => [p.name, p.value])).toEqual([["Hand-holding", 4], [PURPOSE_NOT_SET, 3], ["Winning work", 0.5]]);
  });

  it("falls back to the default list when none is given", () => {
    expect(namedPurposeParts([{ name: "fixing", hours: 1 }])[0]!.name).toBe("Fixing");
  });
});

describe("purposeColours", () => {
  it("gives each purpose its fixed slot by key, whatever its size, in the workspace's order; Hand-holding its own; Not set the neutral", () => {
    const a = [
      { key: "Required", name: "Required", value: 9 },
      { key: "Moves the client's job forward", name: "Moves the client's job forward", value: 1 },
      { key: PURPOSE_NOT_SET, name: PURPOSE_NOT_SET, value: 20 },
    ];
    const b = [{ key: "Hand-holding", name: "Hand-holding", value: 3 }, { key: "Fixing", name: "Fixing", value: 2 }];
    const c = purposeColours([a, b], DEFAULT_PURPOSES);
    expect([...c.entries()]).toEqual([
      ["Moves the client's job forward", "var(--cat-1)"],
      ["Required", "var(--cat-3)"],
      ["Fixing", "var(--cat-6)"],
      ["Hand-holding", "var(--cat-8)"],
      [PURPOSE_NOT_SET, "var(--series-other)"],
    ]);
  });

  it("keeps a purpose's colour when another bar is filtered out or the sizes change", () => {
    const one = purposeColours([[{ key: "Winning work", name: "Winning work", value: 1 }]], DEFAULT_PURPOSES);
    const two = purposeColours([[{ key: "Coordination", name: "Coordination", value: 50 }, { key: "Winning work", name: "Winning work", value: 1 }]], DEFAULT_PURPOSES);
    expect(one.get("Winning work")).toBe(two.get("Winning work"));
  });

  it("has no repeated colour in its palette", () => {
    expect(new Set(PURPOSE_PALETTE).size).toBe(PURPOSE_PALETTE.length);
  });
});

describe("the time-to-serve card", () => {
  it("shows purpose names, never the raw keys", () => {
    const model = capacityModel();
    // The engine fixture labels steps with free text; give them the workspace's purpose keys, as steps made in the app have.
    model.steps = model.steps.map((st, i) => ({ ...st, purpose: DEFAULT_PURPOSES[i % 4]!.key }));
    const setup = capacitySetupFromModel(model);
    const keys = new Set(timeToServe(setup, model).departments.flatMap((d) => d.tiers.flatMap((t) => t.byPurpose.map((x) => x.name))));
    expect(keys.size).toBeGreaterThan(1);
    const html = renderToStaticMarkup(createElement(TimeToServe, { setup, model }));
    const card = html.replace(/&#x27;/g, "'");
    for (const k of keys) {
      const name = DEFAULT_PURPOSES.find((p) => p.key === k)!.name;
      expect(card, k).toContain(`title="${name} `);
      expect(card, k).not.toContain(`title="${k} `);
    }
  });
});
