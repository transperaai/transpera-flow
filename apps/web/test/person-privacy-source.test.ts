import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Members see their own person and "A team member" for everyone else (B1 2b, issue #30). Source text, in the style of
// role-gating.test.ts: every screen that lists people or names one imports the viewer helpers, so one that loses them
// fails here rather than naming a colleague to a member. The behaviour is tested in viewer.test.ts and people-browser.test.ts.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

/** Per-person displays: a member sees only their own row. */
const OWN_ROW = [
  "components/people-page.tsx",
  "components/utilisation-bars.tsx",
  "components/compare-view.tsx",
  "lib/forecast/timeline.ts",
  "lib/scenarios/levers.ts",
];

/** Places that name another person: "A team member". */
const NAMES = [
  "components/issues/issue-page.tsx",
  "components/issues-page.tsx",
  "components/process-issues.tsx",
  "components/process-page.tsx",
  "components/process-canvas.tsx",
  "lib/process-page/about.ts",
  "components/first-principles/first-principles-card.tsx",
  "components/first-principles/first-principles-flow.tsx",
  "lib/churn-drivers.ts",
  "lib/scenarios/scenarios.ts",
  "lib/scenarios/broken.ts",
  "components/forecast/forecast-view.tsx",
];

describe("per-person screens use the viewer helpers", () => {
  it.each(OWN_ROW)("%s shows a member only their own row", (file) => {
    const source = read(file);
    expect(source).toMatch(/from "(@\/lib|\.)\/viewer"/);
    expect(source).toContain("ownRowsOnly(");
  });

  it.each(NAMES)("%s names other people 'A team member'", (file) => {
    const source = read(file);
    expect(source).toMatch(/from "(@\/lib|\.)\/viewer"/);
    expect(source).toMatch(/namedForViewer\(|personName\(/);
  });

  it("the People page filters both the table and the absence rows to the member's own", () => {
    expect(read("components/people-page.tsx").match(/ownRowsOnly\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("the People page says how to get linked when a member has no row", () => {
    expect(read("components/people-page.tsx")).toContain("Your sign-in isn&apos;t linked to a person, so there&apos;s no row of yours to show. Ask an owner to link you on Settings → Access.");
  });

  it("Settings counts a role's people from team_capacity, not from the member's own reads", () => {
    const data = read("lib/data.ts");
    expect(data).toContain("loadTeam(db, ws)");
    expect(data).toContain("roleUsage(roleSteps, team.personRoles, team.clientAssignments,");
    expect(read("app/w/[slug]/settings/people-settings.tsx")).toContain("Your record. Owners and editors see the whole team.");
    expect(read("app/w/[slug]/settings/clients-settings.tsx")).toContain("A_TEAM_MEMBER");
  });
});

describe("issues.detected_key is opaque for old AI-text keys when the reader can't see everyone (B1 2b)", () => {
  it("every page loader of issues reads them through loadIssuesForReader", () => {
    expect(read("lib/data.ts")).toContain("loadIssuesForReader(await getDb(), workspaceId)");
    const processes = read("lib/processes/data.ts");
    expect(processes).not.toMatch(/\bloadIssues\(/);
    expect(processes.match(/loadIssuesForReader\(/g)).toHaveLength(2);
  });

  it("no page reads the stored key", () => {
    // The pages go through lib/data.ts; the dialog/verdict paths load one issue by id. (The AI service, which matched the
    // stored key against its proposals, went with in-app AI.)
    const pages = ["components/workspace-process-page.tsx", "components/overview/workspace-overview.tsx", "app/w/[slug]/issues/page.tsx", "app/w/[slug]/issues/[number]/page.tsx"];
    for (const f of pages) expect(read(f), f).not.toMatch(/\bloadIssues\(/);
  });
});

// Per-person times (C6, #198): never ranked, never compared across people, never in a table column (PRD D20).
describe("per-person times are never ranked or compared", () => {
  const walk = (dir: string): string[] =>
    readdirSync(join(__dirname, "..", "src", dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  it("no file under apps/web/src sorts by a factor", () => {
    const files = walk("");
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) expect(read(f), f).not.toMatch(/sort\([^)]*factor/i);
  });

  it("no file averages, ranks or takes a median of factors", () => {
    for (const f of walk("")) expect(read(f), f).not.toMatch(/(median|average|rank|mean)\w*\([^)]*capacityFactor|capacityFactor[^\n]*(median|average|\.reduce)/i);
  });

  // Measured per-person proposals (#227): the same rules, and only owners and editors with the switch on see them.
  it("no file sorts per-person proposals by value", () => {
    for (const f of walk("")) expect(read(f), f).not.toMatch(/sort\([^)]*\b(proposed|measured|factor)\b/i);
    expect(read("lib/calibration/person-times.ts")).not.toMatch(/\.sort\(|toSorted\(/);
  });

  it("the calibration panel renders the per-person part, and computes it, only when the setup is `on`", () => {
    const source = read("components/calibration/calibration-panel.tsx");
    const uses = [...source.matchAll(/<PersonTimesSection/g)];
    expect(uses).toHaveLength(1);
    const before = source.slice(0, uses[0]!.index);
    expect(before.slice(before.lastIndexOf("{personTimes.state")).startsWith('{personTimes.state === "on"')).toBe(true);
    expect(source).toMatch(/personTimes\.state === "on" && ready\.personRows\s*\?\s*proposePersonTimes\(/);
    // The wizard offers people to match only when given them, and the demo passes none.
    expect(source).toContain('people={personTimes.state === "on" ? personTimes.people : null}');
    expect(read("app/demo/settings/calibration/page.tsx")).toContain('personTimes={{ state: "hidden" }}');
  });

  it("the People page reads per-person times only through personFactors, inside PersonDetailBlock", () => {
    const source = read("components/people-page.tsx");
    expect(source).not.toContain("personCapacityFactors");
    const uses = [...source.matchAll(/personFactors\(/g)];
    expect(uses).toHaveLength(1);
    const block = source.slice(source.indexOf("function PersonDetailBlock"));
    expect(block).toContain("personFactors(");
    expect(source.indexOf("personFactors(")).toBeGreaterThan(source.indexOf("function PersonDetailBlock"));
  });
});

