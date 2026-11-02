import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MrrChart } from "@/components/overview/charts";

// Charts with nothing to draw say so (issue #44) instead of throwing or drawing an empty box.

describe("MrrChart with no months", () => {
  it("renders its empty paragraph and does not throw", () => {
    const html = renderToStaticMarkup(createElement(MrrChart, { points: [], horizonMonths: 12, currency: "GBP" }));
    expect(html).toContain("data-empty");
    expect(html).toContain("No months to show yet.");
    expect(html).not.toContain("<svg");
  });
});
