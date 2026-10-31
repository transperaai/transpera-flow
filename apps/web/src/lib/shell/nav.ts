// The sidebar's groups, items and where they go (issues #93, #98). Pure, so the mapping from a pathname to the
// active item is unit-tested; the sidebar component only renders what this returns. Order and grouping follow the
// prototype's `sidebar()` (apps/web/prototype/app-flow.html).

export type NavIcon = "overview" | "processes" | "issues" | "solutions" | "library" | "people" | "sandbox" | "settings" | "access";

/** How a count badge looks: plain, or a warning. */
export type CountTone = "plain" | "warn";

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
}

const matches = (rest: string, path: string) => rest === path || rest.startsWith(`${path}/`);

/**
 * The shared shape: `base` is where the workspace's pages live (`/w/<slug>`), `rest` the path under it.
 * The workspace root is the Overview, the landing page (issue #100); a process's map (`/p/<id>`) belongs to Processes.
 */
function groups(base: string, rest: string, counts: NavCounts, extra: { settings: boolean; access: boolean; levers?: boolean; share?: boolean }): NavGroup[] {
  const onMap = rest.startsWith("/p/");
  const item = (i: Omit<NavItem, "href" | "active"> & { path: string; active?: boolean }): NavItem => {
    const { path, active, ...fields } = i;
    return { ...fields, href: `${base}${path}`, active: active ?? matches(rest, path) };
  };
  const company: NavItem[] = [
    item({ key: "people", label: "People", path: "/people", icon: "people" }),
    // Who gets too busy, and when (issue #35).
    item({ key: "sandbox", label: "Sandbox", path: "/sandbox", icon: "sandbox" }),
  ];
  if (extra.settings) company.push(item({ key: "settings", label: "Settings", path: "/settings", icon: "settings", active: rest === "/settings" || rest === "/settings/calibration" || rest === "/settings/changes" }));
  if (extra.access) company.push(item({ key: "access", label: "Access", path: "/settings/access", icon: "access" }));
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
      ],
    },
    { key: "company", label: "Company", items: company },
  ];
}

export function workspaceNav({ slug, pathname, canManage, counts }: { slug: string; pathname: string; canManage: boolean; counts: NavCounts }): NavGroup[] {
  const base = `/w/${slug}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "\u0000";
  return groups(base, rest, counts, { settings: true, access: canManage });
}

export const flatItems = (groups: NavGroup[]): NavItem[] => groups.flatMap((g) => g.items);

/** The badge's accessible name: "Issues, 4 open". */
export function countLabel(i: NavItem): string {
  return `${i.label}, ${i.count} ${i.countNoun ?? ""}`.trim();
}
