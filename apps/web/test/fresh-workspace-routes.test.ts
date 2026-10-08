import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPANY_ID, DISTINCTIVE_SETUP, DRAFT, FRESH_SLUG, SECRET_PEOPLE, UNKNOWN_ID, VARIANTS, ZERO_SETUP, type FreshVariant } from "./fresh-workspace-fixture";

// A new client's workspace (issue #243) has a company map and perhaps drafts, and nothing published. No page may answer 404 for
// it; the pages say "nothing published yet" or show the start page. An unknown workspace or process id still gives a 404. The loaders
// are mocked (the database-backed twin is packages/mcp/test/postgrest-fresh-workspace.test.ts); `notFound` and `redirect` throw tagged
// errors, as Next's do.

const state = vi.hoisted(() => ({
  variant: "company map only" as FreshVariant,
  known: true,
  /** Something is published, but the page was asked for a process that isn't one (only the calibration page asks by id). */
  published: false,
  canEdit: true,
  setup: { roles: 0, people: 0, clients: 0, clientGroups: 0, processes: 0, published: 0, companyId: "00000000-0000-4000-8000-0000000000c1" as string | null },
  notFound: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    state.notFound++;
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/components/shell/shell-header", () => ({ ShellHeader: ({ title }: { title: string }) => createElement("header", null, title) }));
vi.mock("@/lib/access-data", () => ({ canEditWorkspace: async () => state.canEdit, currentUserId: async () => "user-1" }));
vi.mock("@/lib/restore/empty", () => ({ workspaceIsEmpty: async () => true }));
vi.mock("@/lib/calibration/data", () => ({ loadCalibrationPage: async () => null }));
vi.mock("@/lib/calibration/client-data", () => ({ loadClientCalibration: async () => null }));
vi.mock("@/lib/calibration/import-data", () => ({
  loadImports: async () => ({ imports: [], previous: {} }),
  loadLeadSourceOptions: async () => [{ id: "ls1", name: "Website", volumeWeek: 5 }],
}));
vi.mock("@/lib/data", async () => {
  const fixture = await import("./fresh-workspace-fixture");
  return {
    // Nothing is published: there is no process to open by default, and the company map is never one.
    loadLiveProcess: async () => null,
    loadProcessForEditing: async () => null,
    loadWorkspaceHead: async () => (state.known ? fixture.freshHead : null),
    loadWorkspaceOverview: async () => (state.known ? fixture.freshOverview(state.variant) : null),
    loadPublishState: async () => (state.known ? { ...fixture.freshPublishState(state.variant), published: state.published } : null),
    loadCompanyId: async () => (state.known ? fixture.COMPANY_ID : null),
    loadWorkspaceSetup: async () => state.setup,
    loadWorkspaceLiveRevisionIds: async () => ({}),
    loadWorkspaceIssues: async () => [],
    loadWorkspaceScenarios: async () => [],
    loadWorkspaceSources: async () => [],
    loadWorkspaceSolutions: async () => ({ solutions: [], links: [], changes: [] }),
    loadProcessNames: async () => [],
    loadMemberNames: async () => Object.fromEntries(fixture.SECRET_PEOPLE.map((n, i) => [`m${i}`, n])),
    loadPendingIdeaCount: async () => 0,
  };
});

type Page = (props: never) => Promise<ReactElement>;
const props = (slug = FRESH_SLUG, searchParams: Record<string, string> = {}) => ({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(searchParams) }) as never;
/** Resolves the async server components in a tree (a page returns `<WorkspaceOverview />` unevaluated), so it can be rendered to a string. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const { type, props: p } = node as ReactElement<{ children?: ReactNode }>;
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return resolve(await (type as (p: unknown) => Promise<ReactNode>)(p));
  if (p.children === undefined) return node;
  const children = await resolve(p.children);
  // Spread, as JSX passes several children, so React doesn't warn about keys on a list it was never given.
  return cloneElement(node as ReactElement<{ children?: ReactNode }>, undefined, ...(Array.isArray(p.children) ? (children as ReactNode[]) : [children]));
}
const html = async (page: Page, p: unknown = props()) => renderToStaticMarkup((await resolve(await page(p as never))) as ReactElement);

/** Each page that used to answer 404, as the route renders it. */
const PAGES: [string, () => Promise<Page>][] = [
  ["/issues", async () => (await import("@/app/w/[slug]/issues/page")).default as Page],
  ["/solutions", async () => (await import("@/app/w/[slug]/solutions/page")).default as Page],
  ["/people", async () => (await import("@/app/w/[slug]/people/page")).default as Page],
  ["/forecast", async () => (await import("@/app/w/[slug]/forecast/page")).default as Page],
  ["/settings/calibration", async () => (await import("@/app/w/[slug]/settings/calibration/page")).default as Page],
  ["/overview", async () => (await import("@/app/w/[slug]/overview/page")).default as Page],
  ["/", async () => (await import("@/app/w/[slug]/page")).default as Page],
];

const USERS: [string, boolean][] = [
  ["an agency admin", true],
  ["an owner", true],
  ["a viewer", false],
];

beforeEach(() => {
  state.variant = "company map only";
  state.known = true;
  state.published = false;
  state.canEdit = true;
  state.setup = { ...ZERO_SETUP };
  state.notFound = 0;
});

describe.each(VARIANTS)("a new client's workspace: %s", (variant) => {
  describe.each(USERS)("for %s", (_who, canEdit) => {
    beforeEach(() => {
      state.variant = variant;
      state.canEdit = canEdit;
      state.setup = { ...DISTINCTIVE_SETUP };
    });

    it.each(PAGES)("%s is not a 404, and says nothing is published or shows the start page", async (_path, load) => {
      const out = await html(await load());
      expect(state.notFound).toBe(0);
      expect(out).toMatch(/data-not-published|data-start-overview/);
    });

    it.each(PAGES)("%s gives an edit button to editors and none to readers", async (path, load) => {
      const out = await html(await load());
      // The People page has no action to call (role-gating.test.ts), so with no draft to open its editors get links only.
      if (canEdit && !(path === "/people" && variant === "company map only")) expect(out).toContain("data-edit-entry");
      else expect(out).not.toContain("data-edit-entry");
    });

    it.each(PAGES)("%s shows a reader no person name, draft name or count", async (_path, load) => {
      if (canEdit) return;
      const out = await html(await load());
      for (const name of [...SECRET_PEOPLE, DRAFT.name]) expect(out).not.toContain(name);
      for (const n of [4711, 4722, 4733, 4744, 4755]) expect(out).not.toContain(String(n));
    });
  });

  it("offers an editor the draft to publish when there is one, else a new process", async () => {
    state.variant = variant;
    const out = await html(await (await import("@/app/w/[slug]/issues/page")).default as Page);
    if (variant === "company map only") {
      expect(out).toContain("New process");
      expect(out).not.toContain("to publish it");
    } else {
      expect(out).toContain(`Open ${DRAFT.name} to publish it`);
      expect(out).toContain(`href="/w/${FRESH_SLUG}/p/${DRAFT.id}/edit"`);
    }
    expect(out).toContain(`href="/w/${FRESH_SLUG}/processes"`);
    expect(out).toContain("Publish a process and this page fills in.");
  });

  it("tells a reader that an owner or editor publishes first", async () => {
    state.variant = variant;
    state.canEdit = false;
    const out = await html(await (await import("@/app/w/[slug]/forecast/page")).default as Page);
    expect(out).toContain("An owner or editor publishes a process first, then this page fills in.");
    expect(out).not.toContain("Open Processes");
  });
});

describe("People with nothing published", () => {
  it("points an editor to Settings, People and shows a reader nothing more than the sentence", async () => {
    const people = (await import("@/app/w/[slug]/people/page")).default as Page;
    const editor = await html(people);
    expect(editor).toContain("Add people in Settings");
    expect(editor).toContain(`href="/w/${FRESH_SLUG}/settings#people-heading"`);
    state.canEdit = false;
    const reader = await html(people);
    expect(reader).not.toContain("Add people in Settings");
    expect(reader).toContain("How busy each person is, and how healthy your clients are, come from a simulation of a published process.");
  });
});

describe("Historical data with nothing published", () => {
  it("still offers the workspace-wide imports", async () => {
    const out = await html((await import("@/app/w/[slug]/settings/calibration/page")).default as Page);
    expect(out).toContain("Calibrating compares a stage history, deals or time logs with a published process.");
    expect(out).toContain("Historical data");
  });

  it("still answers 404 for a ?process= that names no process once something is published", async () => {
    state.published = true;
    const page = (await import("@/app/w/[slug]/settings/calibration/page")).default as Page;
    await expect(html(page, props(FRESH_SLUG, { process: UNKNOWN_ID }))).rejects.toThrow("NOT_FOUND");
    expect(state.notFound).toBe(1);
  });
});

describe("the start page for editors", () => {
  it("builds the company map from the Editor and ticks the checklist from the counts", async () => {
    const { WorkspaceOverview } = await import("@/components/overview/workspace-overview");
    state.setup = { ...ZERO_SETUP, roles: 1, people: 1 };
    state.variant = "company map and one draft";
    const out = renderToStaticMarkup((await resolve(await WorkspaceOverview({ slug: FRESH_SLUG }))) as ReactElement);
    expect(out).toContain(`href="/w/${FRESH_SLUG}/p/${COMPANY_ID}/edit?from=%2Fw%2F${FRESH_SLUG}"`);
    expect([...out.matchAll(/data-setup-item="(\w+)"( data-done="")?/g)].map((m) => [m[1], Boolean(m[2])])).toEqual([
      ["roles", true],
      ["people", true],
      ["clients", false],
      ["process", false],
      ["publish", false],
    ]);
    // "Publish it" opens the draft.
    expect(out).toContain(`href="/w/${FRESH_SLUG}/p/${DRAFT.id}/edit"`);
    expect(out).toContain("data-restore-card");
  });
});

// The route returns the page component unevaluated; resolving it runs the page, as Next does.
const route = (load: () => Promise<unknown>) => async () => async (p: unknown) => resolve(await ((await load()) as (p: unknown) => Promise<ReactNode>)(p));
const processPage = route(() => import("@/app/w/[slug]/p/[processId]/page").then((m) => m.default));
const principlesPage = route(() => import("@/app/w/[slug]/p/[processId]/first-principles/page").then((m) => m.default));

describe("the company map's own URLs", () => {
  const at = (processId: string, searchParams: Record<string, string> = {}) => ({ params: Promise.resolve({ slug: FRESH_SLUG, processId }), searchParams: Promise.resolve(searchParams) });

  it("/p/<companyId> redirects to the Overview", async () => {
    await expect((await processPage())(at(COMPANY_ID))).rejects.toThrow(`REDIRECT /w/${FRESH_SLUG}`);
    expect(state.notFound).toBe(0);
  });

  it("keeps ?version=2 on the way", async () => {
    await expect((await processPage())(at(COMPANY_ID, { version: "2" }))).rejects.toThrow(`REDIRECT /w/${FRESH_SLUG}?version=2`);
  });

  it("/p/<companyId>/first-principles redirects to the Overview", async () => {
    await expect((await principlesPage())(at(COMPANY_ID))).rejects.toThrow(`REDIRECT /w/${FRESH_SLUG}`);
    expect(state.notFound).toBe(0);
  });

  it("still answers 404 for any other unknown id", async () => {
    await expect((await processPage())(at(UNKNOWN_ID))).rejects.toThrow("NOT_FOUND");
    await expect((await principlesPage())(at(UNKNOWN_ID))).rejects.toThrow("NOT_FOUND");
    expect(state.notFound).toBe(2);
  });
});

describe("a workspace that doesn't exist", () => {
  beforeEach(() => {
    state.known = false;
  });

  it.each(PAGES)("%s still answers 404", async (_path, load) => {
    await expect(html(await load(), props("no-such-workspace"))).rejects.toThrow("NOT_FOUND");
    expect(state.notFound).toBe(1);
  });

  it("answers 404 for the company map's URLs too", async () => {
    const at = { params: Promise.resolve({ slug: "no-such-workspace", processId: COMPANY_ID }), searchParams: Promise.resolve({}) };
    await expect((await processPage())(at)).rejects.toThrow("NOT_FOUND");
    await expect((await principlesPage())(at)).rejects.toThrow("NOT_FOUND");
  });
});

