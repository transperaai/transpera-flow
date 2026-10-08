import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canvasTypes } from "../visual/names.mjs";

// Storybook coverage (issue #43): every shared component, chart, canvas node and edge has a story, and the visual suite
// screenshots each story in both themes. A new `ui` component without a story fails here, so the gate can't silently shrink.
// See docs/visual-regression.md for how to add a story.

const WEB = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${WEB}${path}`, "utf8");

/** Components outside `ui`: `[file under src/components, export]`. Add a pair here when you add a shared component. */
const SHARED: [string, string][] = [
  ["help", "Help"],
  ["help", "HelpLabel"],
  ["shell/page", "Page"],
  ["shell/page", "PageHeader"],
  ["shell/shell-header", "ShellHeader"],
  ["shell/phone-read-only", "PhoneReadOnly"],
  ["shell/phone-read-only", "PhoneNotice"],
  ["editor/editor-phone-gate", "EditorPhoneGate"],
  ["shell/error-state", "ErrorState"],
  ["shell/not-published", "NotPublished"],
  ["overview/start-overview", "StartOverview"],
  ["fields", "TextField"],
  ["fields", "DateField"],
  ["fields", "NumberField"],
  ["fields", "SelectField"],
  ["fields", "ToggleField"],
  ["fields", "ChecklistField"],
  ["fields", "ConflictPrompt"],
  ["overview/rating-pill", "RatingPill"],
  ["processes/rating", "RatingDot"],
  ["processes/rating", "RatingPill"],
  ["pay-hidden", "PayHidden"],
  ["simulation-gaps", "GapList"],
  ["simulation-gaps", "MissingForSimulation"],
  ["simulation-gaps", "IncompleteDataNote"],
  ["horizon-picker", "HorizonPicker"],
  ["solutions/solution-cards", "VerdictWord"],
  ["solutions/solution-cards", "SolutionCards"],
  ["provenance-badge", "ProvenanceBadge"],
  ["step-issue-badges", "StepIssueBadges"],
  ["shell/skeletons", "PageSkeleton"],
  ["shell/skeletons", "ListSkeleton"],
  ["shell/skeletons", "CardGridSkeleton"],
  ["shell/skeletons", "TableSkeleton"],
  ["shell/skeletons", "FormSkeleton"],
  ["shell/skeletons", "SettingsSkeleton"],
  ["shell/skeletons", "ChartSkeleton"],
  ["shell/skeletons", "OverviewSkeleton"],
  ["shell/skeletons", "ProcessPageSkeleton"],
  ["shell/skeletons", "EditorSkeleton"],
  ["shell/skeletons", "IssuePageSkeleton"],
  ["shell/skeletons", "SolutionPageSkeleton"],
  ["shell/skeletons", "HistorySkeleton"],
  ["shell/skeletons", "FirstPrinciplesSkeleton"],
  ["shell/empty-state", "EmptyState"],
  ["map/map-placeholder", "MapSkeleton"],
  ["map/map-placeholder", "FirstRunStatus"],
];

const CHARTS: [string, string][] = [
  ["overview/charts", "MrrChart"],
  ["overview/trend-charts", "IssuesDonut"],
  ["overview/trend-charts", "TimeSplitChart"],
  ["overview/trend-charts", "OpenedResolvedChart"],
  ["overview/trend-charts", "BeforeAfterChart"],
  ["forecast/forecast-timeline", "ForecastTimeline"],
  ["forecast/forecast-timeline", "TimelineLegend"],
  ["utilisation-bars", "UtilisationBars"],
  ["wait-by-step", "WaitByStep"],
  ["kpi-strip", "KpiStrip"],
];

/** Every `import { a, b as c } from "module"` in the stories: module -> the names imported (before any `as`). */
function storyImports(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const dir of ["ui", "shared", "charts", "map"]) {
    const folder = `${WEB}stories/${dir}`;
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".stories.tsx"))) {
      for (const m of read(`stories/${dir}/${file}`).matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
        const names = found.get(m[2]!) ?? new Set<string>();
        for (const n of m[1]!.split(",")) names.add(n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim());
        found.set(m[2]!, names);
      }
    }
  }
  return found;
}

describe("Storybook coverage", () => {
  it("has a story for every component in components/ui", () => {
    const components = readdirSync(`${WEB}src/components/ui`).filter((f) => f.endsWith(".tsx"));
    expect(components.length).toBeGreaterThan(0);
    const missing = components.filter((f) => !existsSync(`${WEB}stories/ui/${f.replace(/\.tsx$/, ".stories.tsx")}`));
    expect(missing, `Add stories/ui/<name>.stories.tsx for: ${missing.join(", ")}`).toEqual([]);
  });

  it.each([
    ["shared components", SHARED],
    ["charts", CHARTS],
  ] as const)("has a story that uses each of the %s", (_name, pairs) => {
    const imports = storyImports();
    const missing = pairs.filter(([file, name]) => !imports.get(`@/components/${file}`)?.has(name)).map(([file, name]) => `${name} (components/${file})`);
    expect(missing, `No story imports: ${missing.join(", ")}`).toEqual([]);
  });

  it("lists only components that exist", () => {
    for (const [file, name] of [...SHARED, ...CHARTS]) {
      expect(read(`src/components/${file}.tsx`), `${name} in components/${file}.tsx`).toMatch(new RegExp(`export (?:async )?(?:function|const) ${name}\\b`));
    }
  });

  it("finds the node and edge types the canvas defines (the visual suite checks each is drawn by a map story)", () => {
    const { nodes, edges } = canvasTypes();
    expect(nodes).toEqual(expect.arrayContaining(["step", "terminal", "group"]));
    expect(edges).toEqual(expect.arrayContaining(["branch"]));
  });

  it("renders the process map, which draws every node and edge type, in each map story file", () => {
    const folder = `${WEB}stories/map`;
    const files = readdirSync(folder).filter((f) => f.endsWith(".stories.tsx"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(read(`stories/map/${file}`), file).toContain("<ProcessCanvas");
  });
});
