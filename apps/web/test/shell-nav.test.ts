import { describe, expect, it } from "vitest";
import { countLabel, demoNav, flatItems, workspaceNav, type NavGroup, type NavItem } from "@/lib/shell/nav";

// The sidebar's groups, items and which one is active (issues #93, #98), after the prototype's `sidebar()`.

const nav = (pathname: string, over: Partial<Parameters<typeof workspaceNav>[0]> = {}) =>
  workspaceNav({ slug: "s", pathname, canManage: true, counts: {}, ...over });
const active = (groups: NavGroup[]) => flatItems(groups).filter((i) => i.active).map((i) => i.key);
const item = (groups: NavGroup[], key: string) => flatItems(groups).find((i) => i.key === key);
const PID = "0d5f6f0e-0000-4000-8000-000000000001";

describe("workspaceNav: groups and order", () => {
  it("has the prototype's three groups, in order", () => {
    const g = nav("/w/s");
    expect(g.map((x) => x.label)).toEqual([null, "Improve", "Company"]);
    expect(g.map((x) => x.items.map((i) => i.key))).toEqual([
      ["overview", "processes"],
      ["issues", "solutions", "library", "suggestions"],
      ["sources", "people", "forecast", "settings", "access"],
    ]);
  });
  it("labels the items as the prototype does", () => {
    expect(flatItems(nav("/w/s")).map((i) => i.label)).toEqual([
      "Overview",
      "Processes",
      "Issues",
      "Solutions",
      "Block library",
      "Suggestions",
      "Sources",
      "People",
      "Forecast",
      "Settings",
      "Access",
    ]);
  });
  it("gives every item an icon", () => expect(flatItems(nav("/w/s")).every((i) => i.icon)).toBe(true));
  it("has no Reports, Clients, Scenarios or Runs items", () => {
    const keys = flatItems(nav("/w/s")).map((i) => i.key);
    for (const gone of ["report", "clients", "scenarios", "runs", "map"]) expect(keys).not.toContain(gone);
    expect(flatItems(nav("/w/s")).map((i) => i.href).filter((h) => /\/(reports|clients|runs)\b|panel=scenarios/.test(h))).toEqual([]);
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
  it("is Settings on /settings/rules (Analysis rules)", () => expect(active(nav("/w/s/settings/rules"))).toEqual(["settings"]));
  it("is Settings on /settings/levers (Levers)", () => expect(active(nav("/w/s/settings/levers"))).toEqual(["settings"]));
  it("is Access, not Settings, on /settings/access", () => expect(active(nav("/w/s/settings/access"))).toEqual(["access"]));
  it("is the matching item on each of the other pages", () => {
    for (const [path, key] of [
      ["/w/s/issues", "issues"],
      ["/w/s/solutions", "solutions"],
      ["/w/s/blocks", "library"],
      ["/w/s/suggestions", "suggestions"],
      ["/w/s/sources", "sources"],
    ] as const)
      expect(active(nav(path))).toEqual([key]);
  });
  it("is People on its own page, and not on Settings", () => {
    expect(active(nav("/w/s/people"))).toEqual(["people"]);
    for (const p of ["/w/s", "/w/s/settings", `/w/s/p/${PID}`]) expect(item(nav(p), "people")?.active).toBe(false);
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
      "/w/s/suggestions",
      "/w/s/sources",
      "/w/s/people",
      "/w/s/forecast",
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
  const counts = { processes: 3, openIssues: 4, solutions: 0, pendingSuggestions: 2, unlinkedSources: 1 };
  it("counts processes, open issues and pending suggestions, and warns about unlinked sources", () => {
    const g = nav("/w/s", { counts });
    expect(item(g, "processes")).toMatchObject({ count: 3, tone: "plain" });
    expect(item(g, "issues")).toMatchObject({ count: 4, tone: "plain", countNoun: "open" });
    expect(item(g, "suggestions")).toMatchObject({ count: 2, tone: "ai", countNoun: "pending" });
    expect(item(g, "sources")).toMatchObject({ count: 1, tone: "warn" });
  });
  it("has no count where nothing is counted", () => {
    const g = nav("/w/s", { counts });
    for (const key of ["overview", "library", "people", "settings", "access"]) expect(item(g, key)?.count).toBeUndefined();
  });
  it("leaves the count off when none is given", () => {
    for (const i of flatItems(nav("/w/s"))) expect(i.count).toBeUndefined();
  });
  it("names a count for screen readers", () => {
    expect(countLabel(item(nav("/w/s", { counts }), "issues") as NavItem)).toBe("Issues, 4 open");
    expect(countLabel(item(nav("/w/s", { counts }), "suggestions") as NavItem)).toBe("Suggestions, 2 pending");
  });
});

describe("demoNav", () => {
  const d = (pathname: string, counts = { pendingSuggestions: 2, openIssues: 5, processes: 4 }) => demoNav({ pathname, counts });
  it("lists Northbeam's items in the same groups, without Settings or Access", () => {
    const g = d("/demo");
    expect(g.map((x) => x.items.map((i) => i.key))).toEqual([
      ["overview", "processes"],
      ["issues", "solutions", "library", "suggestions"],
      ["sources", "people", "forecast", "rules", "levers", "ai"],
    ]);
  });
  it("marks AI analysis active on its page", () => {
    expect(active(d("/demo/settings/ai"))).toEqual(["ai"]);
    expect(item(d("/demo"), "ai")?.href).toBe("/demo/settings/ai");
  });
  it("marks Settings active on a workspace's AI analysis page", () => expect(active(nav("/w/s/settings/ai"))).toEqual(["settings"]));
  it("marks Analysis rules active on its page", () => {
    expect(active(d("/demo/settings/rules"))).toEqual(["rules"]);
    expect(item(d("/demo"), "rules")?.href).toBe("/demo/settings/rules");
  });
  it("marks Levers active on its page", () => {
    expect(active(d("/demo/settings/levers"))).toEqual(["levers"]);
    expect(item(d("/demo"), "levers")?.href).toBe("/demo/settings/levers");
  });
  it("marks the active page", () => {
    expect(active(d("/demo"))).toEqual(["overview"]);
    expect(active(d("/demo/p/abc"))).toEqual(["processes"]);
    expect(active(d("/demo/processes"))).toEqual(["processes"]);
    expect(active(d("/demo/issues"))).toEqual(["issues"]);
    expect(active(d("/demo/suggestions"))).toEqual(["suggestions"]);
    expect(active(d("/demo/sources"))).toEqual(["sources"]);
    expect(active(d("/demo/overview"))).toEqual(["overview"]);
    expect(active(d("/demo/people"))).toEqual(["people"]);
    expect(active(d("/demo/forecast"))).toEqual(["forecast"]);
  });
  it("sends Issues to its own page", () => expect(item(d("/demo"), "issues")).toMatchObject({ href: "/demo/issues" }));
  it("counts the seed's open issues, pending suggestions and processes", () => {
    expect(item(d("/demo"), "suggestions")?.count).toBe(2);
    expect(item(d("/demo"), "issues")?.count).toBe(5);
    expect(item(d("/demo"), "processes")?.count).toBe(4);
  });
  it("shows only Processes and Issues on Larkspur, which is a read-only map", () => {
    const items = flatItems(d("/demo/larkspur"));
    expect(items.map((i) => i.key)).toEqual(["processes", "issues"]);
    expect(active(d("/demo/larkspur"))).toEqual(["processes"]);
    expect(items.map((i) => i.href)).toEqual(["/demo/larkspur", "/demo/larkspur?panel=issues"]);
    expect(items[1]?.panel).toBe("issues");
  });
});
