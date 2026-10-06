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

describe("saved AI text is named per reader (B1 2b part 3)", () => {
  const WHO = "{ viewer: live.viewer, people: live.people }";

  it.each([
    ["the Overview", "components/overview/workspace-overview.tsx", ["loadWorkspaceFindings(ws, ", "loadLatestAiViews([company.process.id], "]],
    ["the process page", "components/workspace-process-page.tsx", ["loadWorkspaceFindings(live.workspace.id, ", "loadAiViews([shown.revision.id], ", "loadLatestAiViews([live.process.id], "]],
    ["the first-principles page", "components/workspace-first-principles-page.tsx", ["loadAiViews([live.revision.id], "]],
  ])("%s passes the reader's viewer and people to every AI loader", (_, file, calls) => {
    const source = read(file);
    for (const call of calls) expect(source, call).toContain(`${call}${WHO}`);
  });

  it("the loaders name the rows before the pages read them", () => {
    const data = read("lib/ai/data.ts");
    expect(data).toContain("nameAnalysisRow(row, who)");
    expect(data).toContain(".map((r) => nameFinding(r, who))");
    expect(data).toMatch(/loadAiViews\(revisionIds: readonly string\[\], who: NameSource\)/);
    expect(data).toMatch(/loadLatestAiViews\(processIds: readonly string\[\], who: NameSource\)/);
    expect(data).toMatch(/loadWorkspaceFindings\(workspaceId: string, who: NameSource\)/);
  });

  it("saving an AI run keeps labels: no name goes back into the text before it is stored", () => {
    const service = read("lib/ai/service.ts");
    expect(service).toContain("person_labels: outcome.personLabels");
    expect(service).toContain("personLabels: i.personLabels ?? {}");
    const analyse = read("lib/ai/analyse.ts");
    expect(analyse).not.toMatch(/paragraphs\.map\(back\)/);
    expect(analyse).not.toMatch(/(title|evidence|why|text): back\(/);
  });

  it("an editor's edit of an AI finding turns names back into labels, and what comes back is named for them", () => {
    const actions = read("app/w/[slug]/findings-actions.ts");
    expect(actions).toContain("labelNames(sent, labels, team.people)");
    expect(actions).toContain("nameFinding(updated.finding, team)");
    expect(actions).toContain("await named(db, decided.finding)");
  });
});

describe("issues.detected_key is opaque for AI-text keys when the reader can't see everyone (B1 2b)", () => {
  it("every page loader of issues reads them through loadIssuesForReader", () => {
    expect(read("lib/data.ts")).toContain("loadIssuesForReader(await createClient(), workspaceId)");
    const processes = read("lib/processes/data.ts");
    expect(processes).not.toMatch(/\bloadIssues\(/);
    expect(processes.match(/loadIssuesForReader\(/g)).toHaveLength(2);
  });

  it("only editors' save paths and server-side key matching read the stored key", () => {
    // The pages go through lib/data.ts; the two callers of the stored key are the AI service (editors run Analyse, and it
    // skips proposals already acknowledged) and the dialog/verdict paths, which load one issue by id.
    const users = ["lib/ai/service.ts"];
    for (const f of users) expect(read(f)).toMatch(/\bloadIssues\(/);
    const pages = ["components/workspace-process-page.tsx", "components/overview/workspace-overview.tsx", "app/w/[slug]/issues/page.tsx", "app/w/[slug]/issues/[number]/page.tsx"];
    for (const f of pages) expect(read(f), f).not.toMatch(/\bloadIssues\(/);
  });
});

