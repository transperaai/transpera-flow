import { describe, expect, it } from "vitest";
import type { StepRow } from "@transpera-flow/db";
import { bandLayout, type BandSpec } from "@/lib/editor/lanes";

// Q4: the company map's department bands keep each card's stored x, and its stored y within its lane; the lanes are sized to the cards.

const card = (id: string, x: number, y: number) => ({ id, x, y, parent_step_id: null }) as unknown as StepRow;
const size = () => ({ width: 192, height: 124 });
const spec: BandSpec = {
  lanes: [
    { key: "whole", label: "Sales and whole business" },
    { key: "seo", label: "Organic (SEO)" },
    { key: "ppc", label: "Performance" },
  ],
  laneOf: new Map([
    ["win", "whole"],
    ["a", "seo"],
    ["b", "seo"],
    ["c", "ppc"],
    ["d", "ppc"],
  ]),
};

describe("bandLayout", () => {
  const steps = [card("win", 0, 0), card("a", 288, 0), card("c", 288, 160), card("b", 288, 320), card("d", 288, 480)];
  const out = bandLayout(steps, spec, size);

  it("lays the lanes top to bottom in the given order, each starting where the last ended", () => {
    expect(out.lanes.map((l) => l.label)).toEqual(["Sales and whole business", "Organic (SEO)", "Performance"]);
    for (let i = 1; i < out.lanes.length; i++) expect(out.lanes[i]!.y).toBe(out.lanes[i - 1]!.y + out.lanes[i - 1]!.height);
  });

  it("keeps every card's x and puts it inside its lane, whatever the lane's neighbours did", () => {
    for (const s of steps) {
      const at = out.positions.get(s.id)!;
      const lane = out.lanes.find((l) => l.key === out.laneOf.get(s.id))!;
      expect(at.x).toBe(Number(s.x));
      expect(at.y).toBeGreaterThanOrEqual(lane.y);
      expect(at.y + size().height).toBeLessThanOrEqual(lane.y + lane.height);
    }
  });

  it("keeps the stored distance between cards of one lane that sit close, and closes a long empty stretch", () => {
    // a (y 0) and b (y 320) are 196 apart after a's height of 124: over the gap limit, so closed up; c and d likewise.
    const gap = out.positions.get("b")!.y - (out.positions.get("a")!.y + size().height);
    expect(gap).toBe(48);
    const close = bandLayout([card("a", 0, 0), card("b", 0, 150)], { lanes: [{ key: "x", label: "X" }], laneOf: new Map() }, size);
    expect(close.positions.get("b")!.y - close.positions.get("a")!.y).toBe(150);
  });

  it("leaves a lane with no cards out, and puts a step with no lane in the first", () => {
    const some = bandLayout([card("win", 0, 0), card("x", 0, 200)], spec, size);
    expect(some.lanes.map((l) => l.key)).toEqual(["whole"]);
    expect(some.laneOf.get("x")).toBe("whole");
  });

  it("does not place steps inside a group", () => {
    const inner = { ...card("in", 24, 56), parent_step_id: "win" } as unknown as StepRow;
    expect(bandLayout([card("win", 0, 0), inner], spec, size).positions.has("in")).toBe(false);
  });
});
