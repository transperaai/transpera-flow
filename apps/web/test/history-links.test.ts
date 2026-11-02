import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ProcessesPage } from "@/components/processes/processes-page";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement("a", { href, ...rest }, children as never) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

// Q1 item 8: the company map's History opens from the Processes page as well as from the Overview, straight to its own page.
const loadCard = async () => null;
const page = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(SidebarProvider, null, createElement(ProcessesPage, { rows: [], hrefs: {}, loadCard, ...extra })));
const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

describe("History links", () => {
  it("the Processes page links the company map's History to its history page, not back to Processes", () => {
    const history = anchors(page({ companyMap: { href: "/w/acme", edit: false }, companyHistoryHref: "/w/acme/p/co1/history" })).filter((a) => a.includes("data-company-history"));
    expect(history).toHaveLength(1);
    expect(history[0]).toContain('href="/w/acme/p/co1/history"');
  });
  it("shows no History button when the map has no published version", () => {
    expect(page({})).not.toContain("data-company-history");
  });
});
