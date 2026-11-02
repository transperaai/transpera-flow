import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { workspacePurposes } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { TimeAchieves } from "@/components/overview/time-achieves";
import { DEMO_FORECAST_START } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { demoBundle } from "@/lib/sources/demo";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children?: unknown }) => createElement("a", { href }, children as never) }));

// Q1 item 19: "What the time achieves" on the Overview lists its categories biggest first, with their shares, then Idle.
describe("What the time achieves", () => {
  const live = demoBundle();
  const built = forecastModel(live, 3, DEMO_FORECAST_START);
  const monthly = simulate(built.model!, 3, 1, { monthly: true, monthStarts: built.monthStarts! }).monthly!;
  const html = renderToStaticMarkup(
    createElement(TimeAchieves, { monthly, hoursPerWeek: built.model!.hoursPerWeek, start: DEMO_FORECAST_START, categories: workspacePurposes(live.workspace.settings), span: "3 months" }),
  );
  const legend = [...html.matchAll(/<li[^>]*>.*?<\/li>/g)].map((m) => m[0]).filter((l) => l.includes("data-legend-share") || /Idle/.test(l));

  it("sorts the categories by size and puts Idle last, each with its share", () => {
    const shares = legend.filter((l) => l.includes("data-legend-share")).map((l) => Number(/data-legend-share[^>]*>(\d+)%/.exec(l)![1]));
    expect(shares.length).toBeGreaterThanOrEqual(3);
    const categories = shares.slice(0, -1);
    expect(categories).toEqual([...categories].sort((a, b) => b - a));
    expect(legend.at(-1)).toMatch(/Idle/);
  });

  it("gives every category its own colour", () => {
    const colours = [...html.matchAll(/<li[^>]*>\s*<i[^>]*style="background:([^";]+)/g)].map((m) => m[1]);
    expect(colours.length).toBeGreaterThanOrEqual(3);
    expect(new Set(colours).size).toBe(colours.length);
  });
});
