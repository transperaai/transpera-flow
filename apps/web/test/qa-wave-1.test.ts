import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProcessPart } from "@transpera-flow/db";
import { companyMapView } from "@/lib/overview/company-version";
import { CompanyHistoryView } from "@/components/history/company-history-view";
import { HistoryView } from "@/components/history/history-view";
import type { VersionLinks } from "@/components/history/version-dialogs";
import type { VersionMeta } from "@/lib/history/versions";

// QA wave 1: the individual process page loses its projection block, Sources goes into a closed section at the bottom,
// the process History is a plain change list, and the company map's History can open an old version read only.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
const links: VersionLinks = { edit: "/edit", newProcessEdit: "/p/{id}/edit" };
const versions: VersionMeta[] = [
  { revisionId: "r3", number: 3, live: true, publishedAt: "2026-09-29T10:00:00Z", authorKind: "user", authorName: "Maya Collins", changes: { steps: { added: 1, removed: 0, changed: 2 }, edges: { added: 0, removed: 0, changed: 0 } } },
  { revisionId: "r2", number: 2, live: false, publishedAt: "2026-09-20T10:00:00Z", authorKind: "mcp", authorName: null, changes: null },
  { revisionId: "r1", number: 1, live: false, publishedAt: "2026-09-01T10:00:00Z", authorKind: "user", authorName: "Maya Collins", changes: null },
];

describe("the process page", () => {
  const page = read("components/process-page.tsx");
  it("has no stat cards, projection (horizon) picker or levers", () => {
    for (const gone of ["HeadlineCards", "HorizonPicker", "LeverPanel", 'id="projection"']) expect(page).not.toContain(gone);
  });
  it("puts Sources last, in a section that starts closed", () => {
    expect(page.lastIndexOf("<ProcessSources")).toBeGreaterThan(page.lastIndexOf('id="supporting-data"'));
    const sources = page.slice(page.indexOf("function ProcessSources"), page.indexOf("function Section("));
    // A heading holding a button (not a heading inside a <summary>), closed to start, opened by a #sources address.
    expect(sources).not.toContain("<summary");
    expect(sources).toContain("useState(false)");
    expect(sources).toContain("aria-expanded={open}");
    expect(sources).toContain("aria-controls=\"sources-body\"");
    expect(sources).toContain('"#sources"');
  });
});

describe("the process History", () => {
  const html = renderToStaticMarkup(createElement(HistoryView, { processName: "Lead to live", versions, viewBase: "/w/x/p/1", links }));
  it("lists who, when and what changed for each version", () => {
    expect(html).toContain("Maya Collins");
    expect(html).toContain("Claude (MCP)");
    expect(html).toContain("29 Sep");
    expect(html).toContain("2 steps changed");
    expect(html).toContain("/w/x/p/1?version=2");
  });
  it("has no charts, simulated numbers or horizon picker", () => {
    for (const gone of ["Not run", "Time horizon", "<svg", "per month", "(i)", "About "]) expect(html).not.toContain(gone);
  });
});

describe("the company map History", () => {
  it("offers View on every earlier version, linking to the Overview at that version", () => {
    const html = renderToStaticMarkup(createElement(CompanyHistoryView, { versions, links, viewBase: "/w/x" }));
    expect(html).toContain('href="/w/x?version=2"');
    expect(html).toContain('href="/w/x?version=1"');
    expect(html).not.toContain('href="/w/x?version=3"');
  });
  it("keeps Restore a separate action, only for those who can edit", () => {
    const actions = { restore: async () => ({ status: "error" as const, message: "" }), duplicate: async () => ({ status: "error" as const, message: "" }) };
    expect(renderToStaticMarkup(createElement(CompanyHistoryView, { versions, links, viewBase: "/w/x", actions }))).toContain("Restore");
    expect(renderToStaticMarkup(createElement(CompanyHistoryView, { versions, links, viewBase: "/w/x" }))).not.toContain("Restore");
  });
  it("the Overview draws the live map unless ?version= names an earlier one, which is read only with no Editor link", () => {
    const part = (id: string, number: number) => ({ revision: { id, number } }) as unknown as ProcessPart;
    const [live, old] = [part("r2", 2), part("r1", 1)];
    expect(companyMapView(live, null, true)).toEqual({ map: live, viewingVersion: null, canEdit: true });
    expect(companyMapView(live, live, true)).toEqual({ map: live, viewingVersion: null, canEdit: true });
    expect(companyMapView(live, old, true)).toEqual({ map: old, viewingVersion: 1, canEdit: false });
    expect(companyMapView(null, null, true).canEdit).toBe(false);
  });
});

describe("the Processes page", () => {
  it("says the processes are this workspace's own", () => {
    expect(read("components/processes/processes-page.tsx")).toContain("This workspace's own processes");
    expect(read("components/new-process-dialog.tsx")).not.toContain("<Help");
  });
});
