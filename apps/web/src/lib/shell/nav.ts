// The sidebar's groups, items and where they go (issues #93, #98). Pure, so the mapping from a pathname to the
// active item is unit-tested; the sidebar component only renders what this returns. Order and grouping follow the
// prototype's `sidebar()` (apps/web/prototype/app-flow.html).

export type NavIcon = "overview" | "processes" | "issues" | "solutions" | "library" | "suggestions" | "sources" | "people" | "forecast" | "settings" | "access" | "share";

/** How a count badge looks: plain, "AI" (pending suggestions) or a warning (sources that link to nothing; wired in A53). */
export type CountTone = "plain" | "ai" | "warn";

export interface NavItem {
  key: string;
  label: string;
  href: string;
  active: boolean;
  /** A count shown as a badge; hidden when zero or absent. */
  count?: number;
  tone?: CountTone;
  /** What the count means, for the badge's accessible name ("open", "pending"). */
  countNoun?: string;
  /** A page that is not built yet: it opens a "Coming in A3x" placeholder. */
  soon?: string;
  /** On a map route, this item opens that tab of the map's side panel instead of navigating (the read-only Larkspur demo). */
  panel?: "issues";
  icon: NavIcon;
}

export interface NavGroup {
  key: string;
  /** The group's small heading; the first group has none. */
  label: string | null;
  items: NavItem[];
}

/** Numbers beside the items. Absent means "don't show a badge". */
export interface NavCounts {
  processes?: number;
  /** Tracked issues that are still open. */
  openIssues?: number;
  /** Solutions arrive with A49; until then there is nothing to count. */
  solutions?: number;
  pendingSuggestions?: number;
  /** Sources linked to nothing; wired in A53. */
  unlinkedSources?: number;
}

const matches = (rest: string, path: string) => rest === path || rest.startsWith(`${path}/`);

/**
 * The shared shape: `base` is where the workspace's pages live (`/w/<slug>` or `/demo`), `rest` the path under it.
 * The workspace root is the Overview, the landing page (issue #100); a process's map (`/p/<id>`) belongs to Processes.
 */
function groups(base: string, rest: string, counts: NavCounts, extra: { settings: boolean; access: boolean; levers?: boolean; ai?: boolean; share?: boolean }): NavGroup[] {
  const onMap = rest.startsWith("/p/");
  const item = (i: Omit<NavItem, "href" | "active"> & { path: string; active?: boolean }): NavItem => {
    const { path, active, ...fields } = i;
    return { ...fields, href: `${base}${path}`, active: active ?? matches(rest, path) };
  };
  const company: NavItem[] = [
    item({ key: "sources", label: "Sources", path: "/sources", icon: "sources", count: counts.unlinkedSources, tone: "warn", countNoun: "not linked to anything" }),
    item({ key: "people", label: "People", path: "/people", icon: "people" }),
    // Who gets too busy, and when (issue #35).
    item({ key: "forecast", label: "Forecast", path: "/forecast", icon: "forecast" }),
  ];
  if (extra.settings) company.push(item({ key: "settings", label: "Settings", path: "/settings", icon: "settings", active: rest === "/settings" || rest === "/settings/levers" || rest === "/settings/ai" || rest === "/settings/calibration" }));
  // The demo has no Settings page, so its Levers are reached from the sidebar directly.
  if (extra.levers) company.push(item({ key: "levers", label: "Levers", path: "/settings/levers", icon: "settings" }));
  if (extra.ai) company.push(item({ key: "ai", label: "AI analysis", path: "/settings/ai", icon: "settings" }));
  if (extra.access) company.push(item({ key: "access", label: "Access", path: "/settings/access", icon: "access" }));
  // The read-only links to pages of this workspace (B3): for owners and editors, who make them.
  if (extra.share) company.push(item({ key: "share", label: "Share links", path: "/share", icon: "share" }));
  return [
    {
      key: "main",
      label: null,
      items: [
        item({ key: "overview", label: "Overview", path: "/overview", icon: "overview", active: rest === "" || matches(rest, "/overview") }),
        item({ key: "processes", label: "Processes", path: "/processes", icon: "processes", active: onMap || matches(rest, "/processes"), count: counts.processes, tone: "plain", countNoun: "processes" }),
      ],
    },
    {
      key: "improve",
      label: "Improve",
      items: [
        item({ key: "issues", label: "Issues", path: "/issues", icon: "issues", count: counts.openIssues, tone: "plain", countNoun: "open" }),
        item({ key: "solutions", label: "Solutions", path: "/solutions", icon: "solutions", count: counts.solutions, tone: "plain" }),
        item({ key: "library", label: "Block library", path: "/blocks", icon: "library" }),
        item({ key: "suggestions", label: "Suggestions", path: "/suggestions", icon: "suggestions", count: counts.pendingSuggestions, tone: "ai", countNoun: "pending" }),
      ],
    },
    { key: "company", label: "Company", items: company },
  ];
}

export function workspaceNav({ slug, pathname, canManage, canEdit = false, counts }: { slug: string; pathname: string; canManage: boolean; /** Owners, editors and agency admins: they see Share links. */ canEdit?: boolean; counts: NavCounts }): NavGroup[] {
  const base = `/w/${slug}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "\u0000";
  return groups(base, rest, counts, { settings: true, access: canManage, share: canEdit });
}

/** Northbeam on the demo: no database, so no Settings or Access (but its Levers, edited in memory). */
function demoGroups(pathname: string, counts: NavCounts): NavGroup[] {
  const rest = pathname === "/demo" ? "" : pathname.startsWith("/demo/") ? pathname.slice("/demo".length) : "\u0000";
  return groups("/demo", rest, counts, { settings: false, access: false, levers: true, ai: true });
}

/** Larkspur is a read-only map: just the map, and its issues in the map's side panel. */
function larkspurGroups(): NavGroup[] {
  const base = "/demo/larkspur";
  return [
    {
      key: "main",
      label: null,
      items: [
        { key: "processes", label: "Processes", href: base, active: true, icon: "processes" },
        { key: "issues", label: "Issues", href: `${base}?panel=issues`, active: false, panel: "issues", icon: "issues" },
      ],
    },
  ];
}

export function demoNav({ pathname, counts }: { pathname: string; counts: NavCounts }): NavGroup[] {
  if (pathname === "/demo/larkspur" || pathname.startsWith("/demo/larkspur/")) return larkspurGroups();
  return demoGroups(pathname, counts);
}

export const flatItems = (groups: NavGroup[]): NavItem[] => groups.flatMap((g) => g.items);

/** The badge's accessible name: "Issues, 4 open". */
export function countLabel(i: NavItem): string {
  return `${i.label}, ${i.count} ${i.countNoun ?? ""}`.trim();
}
