import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPANY_ID, FRESH_SLUG, freshHead } from "./fresh-workspace-fixture";

// The Processes page in a new client's workspace (issue #243): "Company map" no longer loops back to the start page, and the empty
// table has working buttons for editors and none for readers.

const state = vi.hoisted(() => ({ canEdit: true, rows: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/shell/shell-header", () => ({ ShellHeader: ({ title }: { title: string }) => createElement("header", null, title) }));
vi.mock("@/lib/access-data", () => ({ canEditWorkspace: async () => state.canEdit }));
vi.mock("@/lib/data", () => ({ loadWorkspaceHead: async () => freshHead, loadCompanyId: async () => COMPANY_ID }));
vi.mock("@/lib/processes/data", () => ({ loadProcessesAndArchived: async () => ({ rows: state.rows, archived: [] }) }));
vi.mock("@/app/w/[slug]/process-admin-actions", () => ({ archiveProcess: vi.fn(), changeProcessKind: vi.fn(), renameProcess: vi.fn(), restoreProcess: vi.fn() }));
vi.mock("@/app/w/[slug]/process-actions", () => ({ createProcess: vi.fn() }));
vi.mock("@/app/w/[slug]/processes/upload-actions", () => ({ createUpload: vi.fn(), previewUpload: vi.fn() }));

const published = { id: "p1", name: "Sales", kind: "pipeline", depth: 1, trail: [], steps: 3, openIssues: 0, rating: null, version: { number: 1, publishedAt: null } };
const draftOnly = { ...published, id: "p2", name: "Quote to cash", version: null };

async function render() {
  const { default: Page } = await import("@/app/w/[slug]/processes/page");
  const element = (await Page({ params: Promise.resolve({ slug: FRESH_SLUG }) } as never)) as ReactElement;
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  state.canEdit = true;
  state.rows = [];
});

describe("the Processes page with nothing published", () => {
  it.each([
    ["no processes", [] as unknown[]],
    ["only a draft", [draftOnly]],
  ])("sends an editor's Company map button to the Editor, returning here, with %s", async (_n, rows) => {
    state.rows = rows;
    const out = await render();
    expect(out).toContain("Edit company map");
    expect(out).toContain(`href="/w/${FRESH_SLUG}/p/${COMPANY_ID}/edit?from=%2Fw%2F${FRESH_SLUG}%2Fprocesses"`);
    expect(out).not.toContain(`href="/w/${FRESH_SLUG}"`);
    // It changes things, so a phone doesn't show it.
    const tag = out.match(/<a [^>]*data-edit-company-map[^>]*>/)?.[0] ?? "";
    expect(tag).toContain("data-edit-entry");
    expect(tag).toContain("max-sm:hidden");
  });

  it("gives members and viewers no Company map button at all", async () => {
    state.canEdit = false;
    for (const rows of [[], [draftOnly]]) {
      state.rows = rows;
      const out = await render();
      expect(out).not.toContain("Company map");
      expect(out).not.toContain(`/p/${COMPANY_ID}`);
    }
  });

  it("gives an editor an empty table with New process and Upload process", async () => {
    const out = await render();
    expect(out).toContain("data-processes-empty");
    expect(out).toContain("No processes yet.");
    expect(out).toContain("New process");
    expect(out).toContain("Upload process");
    expect(out).toContain("data-edit-entry");
  });

  it("gives a reader the sentence and no button", async () => {
    state.canEdit = false;
    const out = await render();
    expect(out).toContain("No processes yet. An owner or editor adds them.");
    expect(out).not.toContain("New process");
    expect(out).not.toContain("Upload process");
    expect(out).not.toContain("data-edit-entry");
  });
});

describe("the Processes page once something is published", () => {
  it("keeps Company map going to the Overview, for editors and readers alike", async () => {
    for (const canEdit of [true, false]) {
      state.canEdit = canEdit;
      state.rows = [published];
      const out = await render();
      expect(out).toContain("Company map");
      expect(out).not.toContain("Edit company map");
      expect(out).toContain(`href="/w/${FRESH_SLUG}"`);
    }
  });
});
