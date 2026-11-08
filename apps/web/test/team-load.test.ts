import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TeamLoad, whatToDo } from "@/components/overview/team-load";
import type { TimelineMonth, TimelineRow } from "@/lib/forecast/timeline";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children?: unknown }) => createElement("a", { href }, children as never) }));

// Q1 item 20: Team load by role, simplified.
const month = (index: number, short: string): TimelineMonth => ({ index, short, label: short, name: short, long: short, from: "", to: "", partial: false, span: null }) as unknown as TimelineMonth;
const months = [month(0, "Nov 26"), month(1, "Dec"), month(2, "Jan 27")];
const stat = (mean: number) => ({ mean, p10: mean, p90: mean }) as never;
const row = (id: string, name: string, means: (number | null)[]): TimelineRow => ({ id, name, series: means.map((m) => (m === null ? null : stat(m))), markers: [] });

describe("what to do", () => {
  const name = (i: number) => months[i]!.short;
  it("says when a team goes over its line and when to start hiring", () => {
    expect(whatToDo([{ name: "Performance managers", overFrom: 2, hireBy: 0 }], name, "3 months")).toEqual(["Performance managers: over the line from Jan 27. Start hiring now."]);
    expect(whatToDo([{ name: "SEO managers", overFrom: 2, hireBy: 1 }], name, "3 months")).toEqual(["SEO managers: over the line from Jan 27. Start hiring by Dec."]);
    expect(whatToDo([{ name: "Tech", overFrom: 0, hireBy: -2 }], name, "3 months")).toEqual(["Tech: over the line now. Start hiring now."]);
  });
  it("says so when no team goes over", () => {
    expect(whatToDo([{ name: "SEO managers", overFrom: null, hireBy: null }], name, "6 months")).toEqual(["No team goes over its line in the next 6 months."]);
    expect(whatToDo([], name, "1 month")).toEqual(["No team goes over its line in the next 1 month."]);
  });
});

describe("the team load rows", () => {
  const html = renderToStaticMarkup(
    createElement(TeamLoad, {
      rows: [row("a", "SEO managers", [0.5, 0.78, 0.9]), row("b", "Tech", [0.4, null, 0.86])],
      months,
      lines: { a: 0.85, b: 0.9 },
      fallbackLine: 0.85,
      advice: null,
      span: "3 months",
      sandboxHref: "/w/x/sandbox",
    }),
  );
  it("has a row per role with a cell a month, coloured against that role's own line", () => {
    const tones = (role: string) => [...new RegExp(`data-role="${role}".*?</tr>`).exec(html)![0].matchAll(/data-tone="(\w+)"/g)].map((m) => m[1]);
    // SEO line 85%: 50% fine, 78% within 10 points, 90% over. Tech line 90%: 40% fine, nobody, 86% within 10 points.
    expect(tones("SEO managers")).toEqual(["ok", "warn", "bad"]);
    expect(tones("Tech")).toEqual(["ok", "none", "warn"]);
  });
  it("puts the percentage in each cell's tooltip, leads with what to do, and keeps the Sandbox link", () => {
    expect(html).toContain('title="Dec: 78% busy, against a line of 85%"');
    expect(html.indexOf("data-todo")).toBeLessThan(html.indexOf("<table"));
    expect(html).toContain("SEO managers: over the line from Jan 27");
    expect(html).toContain('href="/w/x/sandbox"');
    // None of the Sandbox timeline's extras.
    expect(html).not.toMatch(/uncovered|market|starts|leaves/i);
  });
});
