import { describe, expect, it } from "vitest";
import { INSPECTOR_MAX, INSPECTOR_MIN, clampInspector, readLayout } from "@/components/editor/use-panel-layout";
import { resolveTarget, type TourStep } from "@/lib/editor/tour";

// The Editor's side panels (ui-cleanup, Editor row): what is remembered of them, and the tour finding whichever copy of a
// button is showing (History sits in the bar from 1280px and in its "More" menu under it).

describe("the remembered panel layout", () => {
  it("opens both panels at the default width when nothing, or nonsense, is stored", () => {
    for (const raw of [null, "", "not json", "[]", '{"inspectorWidth":"wide"}']) {
      expect(readLayout(raw), String(raw)).toEqual({ paletteCollapsed: false, inspectorCollapsed: false, inspectorWidth: 360 });
    }
  });

  it("reads what was stored, with the inspector's width kept between 320 and 420px", () => {
    expect(readLayout(JSON.stringify({ paletteCollapsed: true, inspectorCollapsed: true, inspectorWidth: 400 }))).toEqual({ paletteCollapsed: true, inspectorCollapsed: true, inspectorWidth: 400 });
    expect(readLayout(JSON.stringify({ inspectorWidth: 9000 })).inspectorWidth).toBe(INSPECTOR_MAX);
    expect(clampInspector(10)).toBe(INSPECTOR_MIN);
  });
});

describe("a tour step with its element in two places", () => {
  const step: TourStep = { id: "history", target: ["[data-tour=history]"], title: "History", body: "" };
  const el = (boxes: number) => ({ getClientRects: () => ({ length: boxes }) }) as unknown as Element;

  it("points at the one that is drawn", () => {
    const hidden = el(0);
    const shown = el(1);
    const root = { querySelector: () => hidden, querySelectorAll: () => [hidden, shown] as unknown as NodeListOf<Element> };
    expect(resolveTarget(step, root)).toBe(shown);
  });

  it("is left out when neither is drawn", () => {
    const root = { querySelector: () => el(0), querySelectorAll: () => [el(0)] as unknown as NodeListOf<Element> };
    expect(resolveTarget(step, root)).toBeNull();
  });
});
