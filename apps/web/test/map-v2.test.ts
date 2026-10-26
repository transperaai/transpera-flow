import { describe, expect, it } from "vitest";
import { northbeamBundle, northbeamIssues, northbeamStepIds, toEngineModel } from "@transpera-flow/db";
import { absenceTest, detectIssues, simulate } from "@transpera-flow/engine";
import { confirmedBadges, confirmedRatings, entryView, registerEntries, stepBadges } from "@/lib/issues/register";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { demoBundle } from "@/lib/sources/demo";
import { groupsToOpen, litIds, withHighlightOpen } from "@/lib/map/highlight";
import { LEGEND_ORDER, ratingOfRank } from "@/lib/map/rating";
import { AUTO_HEIGHT, MAX_FIT_ZOOM, MAX_ZOOM, MIN_FIT_ZOOM, MIN_ZOOM, autoPanelHeight, fitViewport, fitZoom, stepZoom } from "@/lib/map/zoom";

// Map v2 (issue #99): the fit calculation, the red badges, highlighting and the rating colours.

describe("fitting the map to its panel", () => {
  it("fits a small map to the panel, and never blows it up past 115%", () => {
    expect(fitZoom({ width: 800, height: 400 }, { width: 1000, height: 600 })).toBeCloseTo(1.15);
    expect(fitZoom({ width: 1000, height: 500 }, { width: 900, height: 700 })).toBeCloseTo(0.9);
  });

  it("never shrinks a big map below 70%: it scrolls instead", () => {
    expect(fitZoom({ width: 4000, height: 900 }, { width: 800, height: 600 })).toBe(MIN_FIT_ZOOM);
    expect(fitZoom({ width: 900, height: 5000 }, { width: 900, height: 600 })).toBe(MIN_FIT_ZOOM);
    expect(MIN_FIT_ZOOM).toBe(0.7);
    expect(MAX_FIT_ZOOM).toBeGreaterThan(1);
  });

  it("falls back to 100% without a size to fit", () => {
    expect(fitZoom({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(1);
    expect(fitZoom({ width: 800, height: 600 }, { width: 0, height: 0 })).toBe(1);
  });

  it("centres a map that fits across the panel and pins one that does not to the left", () => {
    const small = fitViewport({ x: 0, y: 0, width: 400, height: 200 }, { width: 1000, height: 600 });
    expect(small.zoom).toBeCloseTo(1.15);
    expect(small.x).toBeCloseTo((1000 - 400 * small.zoom) / 2);
    // Down the panel it hangs from the top.
    expect(small.y).toBe(0);
    const big = fitViewport({ x: 100, y: 50, width: 3000, height: 800 }, { width: 800, height: 600 }, { top: 56, right: 24, bottom: 24, left: 24 });
    expect(big.zoom).toBe(0.7);
    // The top left of the content sits just inside the panel's padding.
    expect(big.x + 100 * big.zoom).toBeCloseTo(24);
    expect(big.y + 50 * big.zoom).toBeCloseTo(56);
  });

  it("centres a map that fits down a tall panel only when asked (the Overview's company map)", () => {
    const bounds = { x: 0, y: 0, width: 400, height: 200 };
    const pad = { top: 24, right: 60, bottom: 24, left: 24 };
    expect(fitViewport(bounds, { width: 1000, height: 600 }, pad).y).toBe(24);
    const middle = fitViewport(bounds, { width: 1000, height: 600 }, pad, { middle: true });
    expect(middle.zoom).toBeCloseTo(1.15);
    expect(middle.y).toBeCloseTo(24 + (600 - 48 - 200 * 1.15) / 2);
    // A map taller than the panel at 70% still starts at the top.
    expect(fitViewport({ x: 0, y: 0, width: 400, height: 3000 }, { width: 1000, height: 600 }, pad, { middle: true }).y).toBe(24);
  });

  it("steps the zoom by buttons and stops at the ends", () => {
    expect(stepZoom(1, "in")).toBe(1.15);
    expect(stepZoom(1, "out")).toBe(0.85);
    expect(stepZoom(MAX_ZOOM, "in")).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, "out")).toBe(MIN_ZOOM);
  });
});

/** What the latest run detects: the single points of failure, two of them (Audit is tracked already; Kickoff is not). */
function northbeamDetections() {
  const b = northbeamBundle();
  const model = toEngineModel({ ...b, clients: [], clientServices: [], clientAssignments: [] }, { startDate: "2026-10-05" });
  return detectIssues(model, simulate(model, 30, 1), {}, { absence: absenceTest(model) }).filter((d) => d.key.startsWith("spof:"));
}

describe("red badges count confirmed issues only", () => {
  const entries = registerEntries(northbeamIssues(), northbeamDetections());

  it("leaves out what a run only detected, which still colours the step", () => {
    const detected = entries.filter((e) => e.kind === "detected");
    expect(detected.length).toBeGreaterThan(0);
    const confirmed = confirmedBadges(entries);
    const all = stepBadges(entries);
    const total = (b: typeof all) => Object.values(b).reduce((n, x) => n + x.count, 0);
    const openDetected = detected.filter((e) => entryView(e).open && entryView(e).stepId).length;
    expect(openDetected).toBeGreaterThan(0);
    expect(total(all) - total(confirmed)).toBe(openDetected);
    // The step with only a detection has no badge, but has a rating.
    const onlyDetected = detected.map((e) => entryView(e).stepId!).filter((id) => !confirmed[id]);
    expect(onlyDetected.length).toBeGreaterThan(0);
    for (const id of onlyDetected) expect(all[id]).toBeDefined();
  });

  it("counts tracked, open issues, and not closed ones", () => {
    const [first] = northbeamIssues();
    const closed = registerEntries([{ ...first!, status: "dismissed" }], []);
    expect(confirmedBadges(closed)).toEqual({});
    expect(Object.keys(confirmedBadges(entries)).length).toBeGreaterThan(0);
  });
});

describe("highlighting steps on the map", () => {
  const b = withDemoGroups(demoBundle());
  const ids = northbeamStepIds;
  const none = new Set<string>();

  it("opens the groups a highlighted step is in, and leaves the open state alone otherwise", () => {
    expect(groupsToOpen(b.steps, [ids.qualify])).toEqual([DEMO_GROUP_IDS.conversation]);
    expect(groupsToOpen(b.steps, [ids.start])).toEqual([]);
    const opened = withHighlightOpen(b.steps, none, [ids.qualify]);
    expect([...opened]).toEqual([DEMO_GROUP_IDS.conversation]);
    expect(withHighlightOpen(b.steps, none, null)).toBe(none);
    expect(withHighlightOpen(b.steps, none, [])).toBe(none);
    const already = new Set([DEMO_GROUP_IDS.conversation]);
    expect(withHighlightOpen(b.steps, already, [ids.qualify])).toBe(already);
  });

  it("lights the step itself once its group is open, and the closed group while it is not", () => {
    expect([...litIds(b.steps, new Set([DEMO_GROUP_IDS.conversation]), [ids.qualify])]).toEqual([ids.qualify]);
    expect([...litIds(b.steps, none, [ids.qualify])]).toEqual([DEMO_GROUP_IDS.conversation]);
    expect(litIds(b.steps, none, ["not-a-step"]).size).toBe(0);
    expect(litIds(b.steps, none, null).size).toBe(0);
  });
});

describe("what colours a step (D24: nothing reaches the map until it is acknowledged)", () => {
  const entries = registerEntries(northbeamIssues(), northbeamDetections());
  const [, promoted] = northbeamIssues();

  it("colours a step by its confirmed issues only, never by a detection nobody has acknowledged", () => {
    const rated = confirmedRatings(entries);
    // Kickoff has only a detection, so it stays uncoloured; Audit has the tracked spof issue (Bad).
    expect(rated[northbeamStepIds.kickoff]).toBeUndefined();
    expect(stepBadges(entries)[northbeamStepIds.kickoff]).toBeDefined();
    expect(rated[northbeamStepIds.audit]?.rating).toBe("bad");
  });

  it("does not colour a step by an issue stored with the lowest severity (that reads as Great)", () => {
    const info = northbeamIssues().find((i) => entryView({ kind: "tracked", issue: i, detection: null }).rating === "great")!;
    expect(info.step_id).toBe(northbeamStepIds.qualify);
    expect(confirmedRatings(entries)[northbeamStepIds.qualify]).toBeUndefined();
    // ...though it is still a confirmed issue, so it still counts on the red badge.
    expect(confirmedBadges(entries)[northbeamStepIds.qualify]?.count).toBe(1);
  });

  it("stops colouring a step once its issue is closed", () => {
    const closed = registerEntries([{ ...promoted!, status: "resolved" }], []);
    expect(confirmedRatings(closed)).toEqual({});
  });

  it("turns a rank back into its rating", () => {
    expect([0, 1, 2, 3].map(ratingOfRank)).toEqual(["great", "good", "bad", "risk"]);
    expect(ratingOfRank(-1)).toBeNull();
    expect(ratingOfRank(4)).toBeNull();
    expect(LEGEND_ORDER).toEqual(["risk", "bad", "good", "great"]);
  });
});

describe("panel height that follows the map", () => {
  it("is the map's height at the fitted zoom plus the padding, between 16 and 40 rem", () => {
    const pad = { top: 24, right: 24, bottom: 24, left: 24 };
    // 1000 wide in 1048 (room 1000): zoom 1; 300 tall -> 348, lifted to the 256 floor? no: 348 is above it.
    expect(autoPanelHeight({ width: 1000, height: 300 }, 1048, pad)).toBe(348);
    expect(autoPanelHeight({ width: 1000, height: 50 }, 1048, pad)).toBe(AUTO_HEIGHT.min);
    expect(autoPanelHeight({ width: 1000, height: 3000 }, 1048, pad)).toBe(AUTO_HEIGHT.max);
    // A wide map is fitted no smaller than 70%.
    expect(autoPanelHeight({ width: 4000, height: 500 }, 1048, pad)).toBe(Math.round(500 * 0.7 + 48));
  });
});
