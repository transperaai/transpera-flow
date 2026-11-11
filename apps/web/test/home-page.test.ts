import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The home page in single-client mode (docs/adr/0024-one-workspace-per-deployment.md): one workspace goes straight to it; none
// (the Owner makes the first) and two or more (a demo or QA deployment) keep the page. Data and sign-in are faked.
const state = vi.hoisted(() => ({
  workspaces: [] as { id: string; name: string; slug: string }[],
  admin: false,
}));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
}));
vi.mock("@/lib/auth/env", () => ({ authEnv: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => ({ email: "someone@example.com" }) }));
vi.mock("@/lib/access-data", () => ({ isAgencyAdmin: async () => state.admin }));
vi.mock("@/lib/data", () => ({
  listWorkspaces: async () => state.workspaces,
  listAgencyWorkspaces: async () => state.workspaces.map((w) => ({ ...w, openRiskIssues: 0, lastActivity: null, headline: null })),
}));
vi.mock("@/app/actions", () => ({ createWorkspace: async () => ({}) }));

const { default: HomePage } = await import("@/app/page");
const { redirect } = await import("next/navigation");

const ws = (slug: string, name = slug) => ({ id: `id-${slug}`, name, slug });

describe("the home page", () => {
  beforeEach(() => {
    vi.mocked(redirect).mockClear();
    state.admin = false;
    state.workspaces = [];
  });

  it("goes straight to the only workspace, for the Owner and for everyone else", async () => {
    for (const admin of [false, true]) {
      state.admin = admin;
      state.workspaces = [ws("acme-dental", "Acme Dental")];
      await expect(HomePage()).rejects.toThrow("NEXT_REDIRECT /w/acme-dental");
    }
    expect(redirect).toHaveBeenCalledTimes(2);
  });

  it("keeps the page with no workspaces: the Owner makes the first one there, anyone else is told to ask", async () => {
    state.admin = true;
    vi.stubEnv("ALLOW_MULTIPLE_WORKSPACES", "");
    const owner = renderToStaticMarkup(await HomePage());
    expect(owner).toContain("data-no-workspaces");
    expect(owner).toContain("data-new-workspace");
    state.admin = false;
    expect(renderToStaticMarkup(await HomePage())).toContain("No workspace yet");
    expect(redirect).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("offers the Owner New workspace with two or more only when ALLOW_MULTIPLE_WORKSPACES is on", async () => {
    state.admin = true;
    state.workspaces = [ws("acme"), ws("larkspur")];
    try {
      vi.stubEnv("ALLOW_MULTIPLE_WORKSPACES", "");
      expect(renderToStaticMarkup(await HomePage())).not.toContain("data-new-workspace");
      vi.stubEnv("ALLOW_MULTIPLE_WORKSPACES", "true");
      expect(renderToStaticMarkup(await HomePage())).toContain("data-new-workspace");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is where every way back out of a page leads, so with one workspace they land in it, and none promises a list", () => {
    const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
    for (const f of ["components/app-header.tsx", "app/not-found.tsx"]) {
      const src = read(f);
      expect(src, f).toContain('<Link href="/"');
      expect(src, f).not.toMatch(/your workspaces|All workspaces/);
    }
    // The agency table (Owner, two or more) is only on this page, and "All workspaces" only in the many-workspace switcher.
    const all = ["components/shell/app-sidebar.tsx", "app/w/[slug]/layout.tsx"].map(read).join("\n");
    expect(all).not.toContain("AgencyWorkspaceTable");
  });

  it("keeps the list with two or more workspaces", async () => {
    state.workspaces = [ws("acme"), ws("larkspur")];
    const html = renderToStaticMarkup(await HomePage());
    expect(html).toContain("data-workspaces");
    expect(html).toContain('href="/w/acme"');
    expect(html).toContain('href="/w/larkspur"');
    expect(redirect).not.toHaveBeenCalled();
  });
});
