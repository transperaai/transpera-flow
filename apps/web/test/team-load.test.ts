import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { hiringCalls, TeamLoad } from "@/components/overview/team-load";
import type { TimelineMonth, TimelineRow } from "@/lib/forecast/timeline";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children?: unknown }) => createElement("a", { href }, children as never) }));

// Q1 item 20: Team load by role, simplified.
const month = (index: number, short: string): TimelineMonth => ({ index, short, label: short, name: short, long: short, from: "", to: "", partial: false, span: null }) as unknown as TimelineMonth;
const months = [month(0, "Nov 26"), month(1, "Dec"), month(2, "Jan 27")];
const stat = (mean: number) => ({ mean, p10: mean, p90: mean }) as never;
const row = (id: string, name: string, means: (number | null)[]): TimelineRow => ({ id, name, series: means.map((m) => (m === null ? null : stat(m))), markers: [] });

describe("the hiring call", () => {
  const name = (i: number) => months[i]!.short;
  it("says when to hire and why: start now, or hire by a month", () => {
    expect(hiringCalls([{ name: "Performance managers", overFrom: 2, hireBy: 0 }], name)).toEqual([{ action: "Start hiring now", why: "Performance managers go over their utilisation threshold from Jan 27." }]);
    expect(hiringCalls([{ name: "SEO managers", overFrom: 2, hireBy: 1 }], name)).toEqual([{ action: "Hire by Dec", why: "SEO managers go over their utilisation threshold from Jan 27." }]);
    expect(hiringCalls([{ name: "Tech", overFrom: 0, hireBy: -2 }], name)).toEqual([{ action: "Start hiring now", why: "Tech are over their utilisation threshold now." }]);
  });
  it("puts the soonest hire first, and makes no call when no team goes over", () => {
    const calls = hiringCalls(
      [
        { name: "Later", overFrom: 2, hireBy: 1 },
        { name: "Sooner", overFrom: 1, hireBy: -1 },
        { name: "Fine", overFrom: null, hireBy: null },
      ],
      name,
    );
    expect(calls.map((c) => c.action)).toEqual(["Start hiring now", "Hire by Dec"]);
    expect(hiringCalls([{ name: "SEO managers", overFrom: null, hireBy: null }], name)).toEqual([]);
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
  it("shows the percentage in each cell and its tooltip, leads with a red hiring call, and keeps the Sandbox link", () => {
    expect(html).toContain('title="Dec: 78% busy, against a utilisation threshold of 85%"');
    expect(html).toMatch(/data-busy="78"[^>]*><span aria-hidden="true">78%<\/span>/);
    expect(html.indexOf("data-hire-callout")).toBeLessThan(html.indexOf("<table"));
    expect(html).toMatch(/data-hire-callout[^>]*>.*Start hiring now:<\/b> SEO managers go over their utilisation threshold from Jan 27\./);
    expect(html).toContain('href="/w/x/sandbox"');
    // None of the Sandbox timeline's extras.
    expect(html).not.toMatch(/uncovered|market|starts|leaves/i);
  });
  it("says so, without a red call, when no team goes over", () => {
    const calm = renderToStaticMarkup(createElement(TeamLoad, { rows: [row("a", "SEO managers", [0.5, 0.5, 0.5])], months, lines: { a: 0.85 }, fallbackLine: 0.85, advice: null, span: "3 months" }));
    expect(calm).not.toContain("data-hire-callout");
    expect(calm).toContain("No team goes over its utilisation threshold in the next 3 months.");
  });
});
