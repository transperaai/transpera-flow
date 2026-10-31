import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { countLabel, flatItems, workspaceNav, type NavGroup, type NavItem } from "@/lib/shell/nav";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/w/s", useSearchParams: () => new URLSearchParams() }));

// The sidebar's groups, items and which one is active (issues #93, #98), after the prototype's `sidebar()`.

const nav = (pathname: string, over: Partial<Parameters<typeof workspaceNav>[0]> = {}) =>
  workspaceNav({ slug: "s", pathname, canManage: true, counts: {}, ...over });
const active = (groups: NavGroup[]) => flatItems(groups).filter((i) => i.active).map((i) => i.key);
const item = (groups: NavGroup[], key: string) => flatItems(groups).find((i) => i.key === key);
const PID = "0d5f6f0e-0000-4000-8000-000000000001";

describe("workspaceNav: groups and order", () => {
  it("has the prototype's groups, in order (Set up sits between Improve and Company)", () => {
    const g = nav("/w/s");
    expect(g.map((x) => x.label)).toEqual([null, "Improve", "Set up", "Company"]);
    expect(g.map((x) => x.items.map((i) => i.key))).toEqual([
      ["overview", "processes"],
      ["issues", "solutions", "library"],
      ["setup-clients", "setup-people"],
      ["capacity", "sandbox", "settings", "access"],
    ]);
  });
  it("labels the items as the prototype does", () => {
    expect(flatItems(nav("/w/s")).map((i) => i.label)).toEqual([
      "Overview",
      "Processes",
      "Issues",
      "Solutions",
      "Block library",
      "Tiers & clients",
      "People & roles",
      "Capacity",
      "Sandbox",
      "Settings",
      "Access",
    ]);
  });
  it("gives every item an icon", () => expect(flatItems(nav("/w/s")).every((i) => i.icon)).toBe(true));
  it("has no Reports, Clients, Scenarios or Runs items", () => {
    const keys = flatItems(nav("/w/s")).map((i) => i.key);
    for (const gone of ["report", "clients", "scenarios", "runs", "map"]) expect(keys).not.toContain(gone);
    expect(flatItems(nav("/w/s")).map((i) => i.href).filter((h) => /^\/w\/s\/(reports|clients|runs)\b|panel=scenarios/.test(h))).toEqual([]);
  });
  it("shows Access only to managers", () => {
    expect(item(nav("/w/s", { canManage: false }), "access")).toBeUndefined();
    expect(item(nav("/w/s"), "access")?.href).toBe("/w/s/settings/access");
  });
});

describe("workspaceNav: the active item", () => {
  it("is Overview on the workspace root, the landing page", () => expect(active(nav("/w/s"))).toEqual(["overview"]));
  it("is Processes on a process page and on the processes list", () => {
    expect(active(nav(`/w/s/p/${PID}`))).toEqual(["processes"]);
    expect(active(nav("/w/s/processes"))).toEqual(["processes"]);
  });
  it("is Overview on its own page", () => expect(active(nav("/w/s/overview"))).toEqual(["overview"]));
  it("is Settings on exactly /settings", () => expect(active(nav("/w/s/settings"))).toEqual(["settings"]));
  it("is Access, not Settings, on /settings/access", () => expect(active(nav("/w/s/settings/access"))).toEqual(["access"]));
  it("is the matching item on each of the other pages", () => {
    for (const [path, key] of [
      ["/w/s/issues", "issues"],
      ["/w/s/solutions", "solutions"],
      ["/w/s/blocks", "library"],
    ] as const)
      expect(active(nav(path))).toEqual([key]);
  });
  it("is Capacity on its own page, and not on Settings", () => {
    expect(active(nav("/w/s/capacity"))).toEqual(["capacity"]);
    for (const p of ["/w/s", "/w/s/settings", `/w/s/p/${PID}`]) expect(item(nav(p), "capacity")?.active).toBe(false);
  });
  it("marks at most one item", () => {
    for (const p of ["/w/s", "/w/s/issues", "/w/s/settings", "/w/s/settings/access", "/w/s/nowhere"]) expect(active(nav(p)).length).toBeLessThanOrEqual(1);
  });
  it("does not confuse another workspace with a prefix of this one", () => {
    expect(active(nav("/w/s2/issues"))).toEqual([]);
    expect(active(nav("/w/s2"))).toEqual([]);
  });
});

describe("workspaceNav: hrefs", () => {
  it("points each item at its page", () => {
    expect(flatItems(nav("/w/s")).map((i) => i.href)).toEqual([
      "/w/s/overview",
      "/w/s/processes",
      "/w/s/issues",
      "/w/s/solutions",
      "/w/s/blocks",
      "/w/s/setup/clients",
      "/w/s/setup/people",
      "/w/s/capacity",
      "/w/s/sandbox",
      "/w/s/settings",
      "/w/s/settings/access",
    ]);
  });
  it("marks the pages that are not built yet with the ticket that builds them", () => {
    const soon = flatItems(nav("/w/s")).filter((i) => i.soon).map((i) => [i.key, i.soon]);
    // Solutions arrived with A49 and A50: nothing in the sidebar is waiting for a ticket now.
    expect(soon).toEqual([]);
  });
});

describe("workspaceNav: counts", () => {
  const counts = { processes: 3, openIssues: 4, solutions: 0 };
  it("counts processes and open issues", () => {
    const g = nav("/w/s", { counts });
    expect(item(g, "processes")).toMatchObject({ count: 3, tone: "plain" });
    expect(item(g, "issues")).toMatchObject({ count: 4, tone: "plain", countNoun: "open" });
  });
  it("does not list Sources: it is hidden from the menu (the page still opens by its address)", () => {
    expect(item(nav("/w/s", { counts }), "sources")).toBeUndefined();
    expect(active(nav("/w/s/sources"))).toEqual([]);
  });
  it("has no count where nothing is counted", () => {
    const g = nav("/w/s", { counts });
    for (const key of ["overview", "library", "capacity", "settings", "access"]) expect(item(g, key)?.count).toBeUndefined();
  });
  it("leaves the count off when none is given", () => {
    for (const i of flatItems(nav("/w/s"))) expect(i.count).toBeUndefined();
  });
  it("names a count for screen readers", () => {
    expect(countLabel(item(nav("/w/s", { counts }), "issues") as NavItem)).toBe("Issues, 4 open");
  });
});

describe("workspaceNav: pages that are gone", () => {
  it("has no AI analysis item or page: in-app AI is gone (cut list item 1)", () => {
    expect(item(nav("/w/s"), "ai")).toBeUndefined();
    expect(active(nav("/w/s/settings/ai"))).toEqual([]);
  });
  it("has no Analysis rules item: the rules editor is gone (B17, D40)", () => {
    expect(active(nav("/w/s/settings/rules"))).toEqual([]);
  });
  it("has no Levers or Share links item: both are gone (P0)", () => {
    const keys = flatItems(nav("/w/s")).map((i) => i.key);
    expect(keys).not.toContain("levers");
    expect(keys).not.toContain("share");
    expect(active(nav("/w/s/settings/levers"))).toEqual([]);
    expect(active(nav("/w/s/share"))).toEqual([]);
  });
});

describe("the live shell's workspace tile (client branding, issue #34)", () => {
  const shell = (logoUrl: string | null) => {
    const props: ComponentProps<typeof WorkspaceShell> = {
      mode: "live",
      defaultOpen: true,
      slug: "s",
      workspaceName: "Northbeam Digital",
      logoUrl,
      workspaces: [{ name: "Northbeam Digital", href: "/w/s" }],
      canManage: true,
      counts: {},
      viewer: null,
      children: null,
    };
    return renderToStaticMarkup(createElement(WorkspaceShell, props));
  };
  it("passes the logo through to the tile: an <img> on the white tile, decorative, no monogram", () => {
    const html = shell("https://abc.supabase.co/storage/v1/object/public/branding/x.png");
    expect(html).toContain('<img src="https://abc.supabase.co/storage/v1/object/public/branding/x.png" alt=""');
    expect(html).toContain("bg-logo-tile");
    expect(html).not.toMatch(/>N<\/span>/);
  });
  it("keeps the monogram with no logo", () => {
    const html = shell(null);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("bg-logo-tile");
    expect(html).toMatch(/>N<\/span>/);
  });
});
