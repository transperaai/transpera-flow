import { readFileSync } from "node:fs";
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

  it("the People page says how to get linked when a member has no row", () => {
    expect(read("components/people-page.tsx")).toContain("Your sign-in isn&apos;t linked to a person, so there&apos;s no row of yours to show. Ask an owner to link you on Settings → Access.");
  });

  it("Settings counts a role's people from team_capacity, not from the member's own reads", () => {
    const data = read("lib/data.ts");
    expect(data).toContain("loadTeam(supabase, ws)");
    expect(data).toContain("roleUsage(roleSteps.data ?? [], team.personRoles, team.clientAssignments,");
    expect(read("app/w/[slug]/settings/people-settings.tsx")).toContain("Your record. Owners and editors see the whole team.");
    expect(read("app/w/[slug]/settings/clients-settings.tsx")).toContain("A_TEAM_MEMBER");
  });
});
