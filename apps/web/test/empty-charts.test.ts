import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { northbeamBundle, toEngineModel } from "@transpera-flow/db";
import { MrrChart } from "@/components/overview/charts";
import { UtilisationBars } from "@/components/utilisation-bars";

// Charts with nothing to draw say so (issue #44) instead of throwing or drawing an empty box.

describe("MrrChart with no months", () => {
  it("renders its empty paragraph and does not throw", () => {
    const html = renderToStaticMarkup(createElement(MrrChart, { points: [], horizonMonths: 12, currency: "GBP" }));
    expect(html).toContain("data-empty");
    expect(html).toContain("No months to show yet.");
    expect(html).not.toContain("<svg");
  });
});

describe("UtilisationBars with no roles", () => {
  it("renders its empty paragraph", () => {
    const model = { ...toEngineModel(northbeamBundle(), { startDate: "2026-10-05" }), roles: {} };
    const html = renderToStaticMarkup(createElement(UtilisationBars, { model, result: null }));
    expect(html).toContain("data-empty");
    expect(html).toContain("No roles to show. Add roles in Settings.");
  });

  it("still draws the bars when there are roles", () => {
    const model = toEngineModel(northbeamBundle(), { startDate: "2026-10-05" });
    const html = renderToStaticMarkup(createElement(UtilisationBars, { model, result: null }));
    expect(html).not.toContain("No roles to show");
    expect(html).toContain("How busy each role is");
  });
});
