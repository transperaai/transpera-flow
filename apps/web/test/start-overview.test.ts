import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StartOverview } from "@/components/overview/start-overview";
import { setupChecklist } from "@/lib/overview/setup";

// The page a new client's workspace opens on (issue #243): editors get the ways to build it out and a checklist; members and
// viewers get one plain sentence.

vi.mock("@/components/shell/shell-header", () => ({ ShellHeader: ({ title }: { title: string }) => createElement("header", null, title) }));

const ZERO = { roles: 0, people: 0, clients: 0, clientGroups: 0, processes: 0, published: 0 };
const create = (async () => ({})) as never;
const upload = { preview: async () => ({}), create: async () => ({}) } as never;
const FROM = "/w/acme/p/co1/edit?from=%2Fw%2Facme";

const editor = (over: Record<string, unknown> = {}, counts: Partial<typeof ZERO> = {}) =>
  renderToStaticMarkup(
    createElement(StartOverview, {
      slug: "acme",
      name: "Acme",
      canEdit: true,
      checklist: setupChecklist({ ...ZERO, ...counts }, "/w/acme", null),
      drafts: [],
      companyEditHref: FROM,
      create,
      upload,
      canRestore: false,
      ...over,
    }),
  );

describe("the start page for an editor", () => {
  it("offers New process, Upload process and Build the company map, each an edit entry", () => {
    const html = editor();
    expect(html).toContain("Set up Acme");
    expect(html).toContain("New process");
    expect(html).toContain("Upload process");
    expect(html).toContain("Build the company map");
    expect(html).toContain(`href="${FROM}"`);
    expect(html).toContain("data-build-company-map");
    // New process, Upload process and the company map link: every control that changes something is edit-only on a phone.
    expect(html.match(/data-edit-entry/g)).toHaveLength(3);
    expect(html.match(/max-sm:hidden/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("has no Build link when the workspace has no company map", () => {
    const html = editor({ companyEditHref: null });
    expect(html).not.toContain("Build the company map");
    expect(html).not.toContain("data-build-company-map");
    expect(html).toContain("New process");
  });

  it("lists the five checklist items in order, with data-done matching the counts", () => {
    const html = editor({}, { roles: 2, people: 1 });
    const items = [...html.matchAll(/<li data-setup-item="(\w+)"( data-done="")?/g)].map((m) => [m[1], Boolean(m[2])]);
    expect(items).toEqual([
      ["roles", true],
      ["people", true],
      ["clients", false],
      ["process", false],
      ["publish", false],
    ]);
    expect(html).toContain("(done)");
    expect(html).toContain("(to do)");
    expect(html).toContain("data-setup-checklist");
    // Ticks only: the counts themselves are not shown.
    expect(html).not.toMatch(/>\s*2\s*</);
  });

  it("keeps the checklist links as plain navigation, not edit entries", () => {
    const html = editor();
    for (const href of ["/w/acme/settings#roles-heading", "/w/acme/settings#people-heading", "/w/acme/settings#clients-heading", "/w/acme/processes"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("lists the processes not yet published", () => {
    const html = editor({ drafts: [{ id: "d1", name: "Sales pipeline" }] });
    expect(html).toContain("These haven&#x27;t been published yet:");
    expect(html).toContain('href="/w/acme/p/d1"');
    expect(html).toContain("Sales pipeline");
    expect(editor()).not.toContain("These haven&#x27;t been published yet:");
  });

  it("offers importing with Claude, and the restore card only when it can restore", () => {
    const without = editor();
    expect(without).toContain("Other ways to start");
    expect(without).toContain("set_active_workspace");
    expect(without).toContain("import_process");
    expect(without).toContain('href="/settings/tokens"');
    expect(without).not.toContain("data-restore-card");
    const withRestore = editor({ canRestore: true });
    expect(withRestore).toContain("data-restore-card");
    expect(withRestore).toContain("Restore a backup");
    expect(withRestore).toContain("Choose a backup file");
    expect(withRestore).toContain('href="/w/acme/restore"');
  });
});

describe("the start page for a member or viewer", () => {
  const reader = () =>
    renderToStaticMarkup(createElement(StartOverview, { slug: "acme", name: "Acme", canEdit: false, checklist: null, drafts: [], companyEditHref: null, canRestore: false }));

  it("says only that nothing is published yet", () => {
    const html = reader();
    expect(html).toContain("data-start-overview");
    expect(html).toContain("Acme has nothing published yet");
    expect(html).toContain("The Overview shows the company map, headline numbers and trends once an owner or editor publishes a process.");
  });

  it("has no buttons, edit entries, checklist, drafts or restore card", () => {
    const html = reader();
    for (const absent of ["data-edit-entry", "<button", "data-setup-checklist", "data-setup-item", "data-restore-card", "Other ways to start", "New process", "<a "]) {
      expect(html).not.toContain(absent);
    }
  });
});
