import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type SourceLinkRow } from "@transpera-flow/db";
import { SourcesPage } from "@/components/sources-page";
import { LINK_HELP } from "@/components/sources/link-chips";
import { SOURCE_DIALOG_HELP } from "@/components/sources/source-dialog";
import { LIBRARY_HELP } from "@/components/sources/library-filters";
import { demoBundle, demoCitations, demoLinkTargets, demoPageSources, demoSourceLinks, DEMO_UNLINKED_SOURCE_ID } from "@/lib/sources/demo";
import { demoNav, flatItems, workspaceNav } from "@/lib/shell/nav";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/demo/sources", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/app/w/[slug]/source-actions", () => ({
  createSource: async () => ({ status: "error", message: "" }),
  saveSourceField: async () => ({ status: "error", message: "" }),
  deleteSource: async () => ({ status: "error", message: "" }),
  linkSource: async () => ({ status: "error", message: "" }),
  unlinkSource: async () => ({ status: "error", message: "" }),
  searchSourcesPage: async () => ({ status: "error", message: "" }),
  readSourceBody: async () => ({ status: "error", message: "" }),
}));

// The Sources page (issue #118, A53): each source with its title, type, date, quote and links as chips, "+ Link", a warning
// on one that is linked to nothing, the sidebar's count, and an (i) on every setting and rule on the screen.

const bundle = demoBundle();
const page = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(SourcesPage, {
      workspaceId: bundle.workspace.id,
      memory: demoPageSources(),
      citations: demoCitations(bundle),
      links: demoSourceLinks(),
      targets: demoLinkTargets(bundle),
      mode: "demo",
      processBase: "/demo/p",
      ...over,
    }),
  );
/** The markup of one source's row in the library table. */
const row = (html: string, title: string) => new RegExp(`<tr data-source-row="[^"]*"[^>]*>(?:(?!</tr>)[\\s\\S])*?aria-label="Open ${title}"[\\s\\S]*?</tr>`).exec(html)![0];
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// What a person sees once a row is open (the full text, chips, "Link to…", the quotes) needs a browser: see
// sources-library-browser.test.ts. Here is the table the page draws first.
describe("the Sources page", () => {
  const html = page();

  it("lists each source as a table row with its title, kind, date and speakers", () => {
    const interview = row(html, "Strategy walkthrough");
    expect(text(interview)).toContain("Strategy walkthrough");
    expect(text(interview)).toContain("Transcript");
    expect(interview).toContain("2026-09-12");
    expect(text(interview)).toContain("Maya Collins, Rosa Diaz");
    const notes = row(html, "Notes: ops walkthrough with Leah");
    expect(text(notes)).toContain("Notes");
    expect(notes).toContain("2026-09-18");
    expect(html).toContain('aria-label="Sources"');
    for (const heading of ["Title", "Kind", "Date", "Speakers", "Linked to"]) expect(html).toContain(`>${heading}</th>`);
  });

  it("says what each source is linked to, by group", () => {
    const interview = text(row(html, "Strategy walkthrough"));
    expect(interview).toMatch(/Processes .*Issues #\d+/);
  });

  it("has the search, the kind and process filters, Not linked only and the sort above the table, and + Add source", () => {
    expect(html).toContain('aria-label="Search sources"');
    expect(html).toContain('aria-label="Filter by kind"');
    expect(html).toContain('aria-label="Filter by process"');
    expect(html).toContain('aria-label="Sort sources"');
    expect(text(html)).toContain("Not linked only");
    expect(html).toContain("+ Add source");
    expect(text(html)).toContain("3 sources.");
  });

  it("flags a source that is linked to nothing, and only that one", () => {
    expect(text(row(html, "Notes: ops walkthrough with Leah"))).toContain("Not linked");
    expect(text(row(html, "Strategy walkthrough"))).not.toContain("Not linked");
    expect(text(row(html, "Sales team notes"))).not.toContain("Not linked");
    expect(text(html)).toContain("1 source isn't linked to anything yet.");
    expect(html).toContain('data-unlinked-count="1"');
  });

  it("flags every source when none is linked, and none when all are", () => {
    const none = page({ links: [] });
    expect((none.match(/data-linked="false"/g) ?? []).length).toBe(demoPageSources().length);
    expect(text(none)).toContain("3 sources aren't linked to anything yet.");
    const sources = demoPageSources();
    const links: SourceLinkRow[] = sources.map((s, i) => ({ ...demoSourceLinks()[0]!, id: `x${i}`, source_id: s.id }));
    const all = page({ links });
    expect(all).not.toContain('data-linked="false"');
    expect(all).not.toContain("data-unlinked-flag");
    expect(all).not.toContain("aren't linked");
  });

  it("is read-only for a viewer: no + Add source, and the table still shows", () => {
    const view = page({ mode: "readonly" });
    expect(view).not.toContain("+ Add source");
    expect(text(view)).toContain("You can read the sources here");
    expect(text(view)).toContain("Not linked");
    expect(view).toContain("data-source-row");
  });

  it("says what to do when there are no sources", () => {
    expect(text(page({ memory: [], links: [], citations: {} }))).toContain("No sources yet. Add the audit's transcripts and notes and link each one");
  });

  it("gives the search, each filter, the sort and the 'Not linked only' toggle their (i)", () => {
    for (const help of Object.values(LIBRARY_HELP)) expect(html).toContain(`About ${help.label}`);
  });
});

describe("the sidebar's count", () => {
  it("counts the sources linked to nothing beside Sources, as a warning", () => {
    const counts = { unlinkedSources: 1 };
    for (const groups of [demoNav({ pathname: "/demo/sources", counts }), workspaceNav({ slug: "s", pathname: "/w/s/sources", canManage: false, counts })]) {
      const sources = flatItems(groups).find((i) => i.key === "sources")!;
      expect(sources).toMatchObject({ count: 1, tone: "warn", countNoun: "not linked to anything", active: true });
    }
  });

  it("matches the demo's sample: one source is unlinked", () => {
    expect(demoPageSources().filter((s) => !demoSourceLinks().some((l) => l.source_id === s.id)).map((s) => s.id)).toEqual([DEMO_UNLINKED_SOURCE_ID]);
    const layout = readFileSync(join(__dirname, "..", "src/app/demo/layout.tsx"), "utf8");
    expect(layout).toContain("unlinkedSources: unlinkedSources(demoPageSources(), demoSourceLinks()).length");
    const live = readFileSync(join(__dirname, "..", "src/app/w/[slug]/layout.tsx"), "utf8");
    expect(live).toContain("unlinkedSources: shell.unlinkedSources");
  });
});

describe("help on the Sources screen", () => {
  const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
  const dialog = read("components/sources/source-dialog.tsx");
  const chips = read("components/sources/link-chips.tsx");

  it("has a description and an example for every control and rule", () => {
    expect(Object.keys(LIBRARY_HELP).sort()).toEqual(["kind", "process", "search", "sort", "unlinked"]);
    expect(Object.keys(SOURCE_DIALOG_HELP).sort()).toEqual(["choice", "date", "existing", "file", "kind", "quote", "target", "title", "type"]);
    for (const [key, help] of [...Object.entries(SOURCE_DIALOG_HELP), ...Object.entries(LINK_HELP), ...Object.entries(LIBRARY_HELP)]) {
      expect(help.label.length, key).toBeGreaterThan(2);
      expect(help.description.length, `${key} description`).toBeGreaterThan(30);
      expect(help.example.length, `${key} example`).toBeGreaterThan(8);
    }
  });

  it("shows an (i) beside each of them", () => {
    for (const key of Object.keys(SOURCE_DIALOG_HELP)) {
      expect(dialog.includes(`help={SOURCE_DIALOG_HELP.${key}}`) || dialog.includes(`<Help {...SOURCE_DIALOG_HELP.${key}} />`), `${key} has no (i) in the dialog`).toBe(true);
    }
    expect(chips).toContain("<Help {...LINK_HELP.unlinked} />");
    expect(chips).toContain("<Help {...LINK_HELP.linked} />");
  });

  it("asks the questions the prototype does, in its words", () => {
    for (const label of ["Title", "Type", "Date", "Quote or excerpt", "Link it to (required)"]) expect(Object.values(SOURCE_DIALOG_HELP).map((h) => h.label)).toContain(label);
    expect(dialog).toContain("Add source");
    expect(dialog).toContain("Link source");
  });

  it("keeps to plain English: no jargon words", () => {
    for (const help of [...Object.values(SOURCE_DIALOG_HELP), ...Object.values(LINK_HELP), ...Object.values(LIBRARY_HELP)]) {
      expect(`${help.description} ${help.example}`).not.toMatch(/\b(RLS|jsonb|payload|enum|schema|FK|provenance|foreign key)\b/i);
    }
  });
});
