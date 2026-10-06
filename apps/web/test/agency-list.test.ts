import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { northbeamBundle, toEngineModel } from "@transpera-flow/db";
import { clientHealthSummary, simulate, type Rating } from "@transpera-flow/engine";
import { AgencyWorkspaceTable } from "@/components/agency-workspace-table";
import type { AgencyWorkspaceRow } from "@/lib/data";
import { headlineIsFresh, headlineNumbers, pickHeadline, sameHeadline, type HeadlineNumbers } from "@/lib/overview/headline";
import { timeSplitOf, workingShare } from "@/lib/overview/health";

// The agency's workspace list and editors changing Client health rules (issue #30, B1 part 3): the headline numbers the Overview
// records, the table that shows them, and the wiring of the health rules' save and gate (read from source, as the editor-help
// test does). The database side is in packages/db/test/role-matrix.test.ts.

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const model = toEngineModel(northbeamBundle(), { startDate: "2026-10-05" });
const result = simulate(model, 6, 1);
const ratings = (...r: (Rating | null)[]) => r.map((rating) => ({ rating }));

describe("headlineNumbers", () => {
  it("takes flow efficiency from the time split, the attention count from the process ratings and the client groups from the run", () => {
    const n = headlineNumbers(model, result, ratings("risk", "bad", "good", "great", null));
    const split = timeSplitOf(model, result);
    expect(n.flow_efficiency).toBe(split ? workingShare(split) : null);
    expect(n.flow_efficiency).toBeGreaterThanOrEqual(0);
    expect(n.flow_efficiency).toBeLessThanOrEqual(1);
    expect(n.processes_attention).toBe(2);
    expect(n.processes_total).toBe(5);
    const groups = clientHealthSummary(model, result).groups;
    expect(n.client_groups_total).toBe(groups.length);
    expect(n.client_groups_at_risk).toBe(groups.filter((g) => g.rating === "risk").length);
  });

  it("counts only Operational risk and Bad processes, and no processes as zero of zero", () => {
    expect(headlineNumbers(model, result, ratings("good", "great", null)).processes_attention).toBe(0);
    const none = headlineNumbers(model, result, []);
    expect(none.processes_attention).toBe(0);
    expect(none.processes_total).toBe(0);
  });

  it("is plain JSON of the shape the table's check accepts: integers, and a share between 0 and 1 or null", () => {
    const n = headlineNumbers(model, result, ratings("risk"));
    expect(JSON.parse(JSON.stringify(n))).toEqual(n);
    for (const k of ["processes_attention", "processes_total", "client_groups_at_risk", "client_groups_total"] as const) {
      expect(Number.isInteger(n[k]), k).toBe(true);
      expect(n[k], k).toBeGreaterThanOrEqual(0);
    }
    // A run with no step facts has nothing to measure: null, not 0.
    expect(headlineNumbers(model, { ...result, stepFacts: undefined }, []).flow_efficiency).toBeNull();
  });
});

describe("pickHeadline and sameHeadline", () => {
  const n: HeadlineNumbers = { flow_efficiency: 0.4, processes_attention: 1, processes_total: 4, client_groups_at_risk: 0, client_groups_total: 2 };

  it("pickHeadline copies exactly the five fields, dropping anything else the caller sent", () => {
    const sneaky = { ...n, pay: { rate: 99 }, overtime_cost: 5 } as HeadlineNumbers;
    expect(Object.keys(pickHeadline(sneaky)).sort()).toEqual(
      ["client_groups_at_risk", "client_groups_total", "flow_efficiency", "processes_attention", "processes_total"],
    );
    expect(pickHeadline(sneaky)).toEqual(n);
  });

  it("sameHeadline is true for the same numbers in any key order, and false when any number, a key or the value's type differs", () => {
    expect(sameHeadline({ ...n }, n)).toBe(true);
    expect(sameHeadline(JSON.parse(JSON.stringify(n, Object.keys(n).sort())), n)).toBe(true);
    expect(sameHeadline({ ...n, processes_attention: 2 }, n)).toBe(false);
    expect(sameHeadline({ ...n, flow_efficiency: null }, n)).toBe(false);
    expect(sameHeadline({ ...n, extra: 1 }, n)).toBe(false);
    expect(sameHeadline(null, n)).toBe(false);
    expect(sameHeadline("x", n)).toBe(false);
  });

  it("recordHeadline writes when the numbers changed, even with the same revisions inside the hour, and sends only the five fields", () => {
    const source = read("app/w/[slug]/headline-actions.ts");
    expect(source).toMatch(/fresh && sameHeadline\(/);
    expect(source).toContain("numbers: { ...pickHeadline(numbers) }");
    expect(source).not.toContain("...numbers,");
    // The database stamps who and when; the browser doesn't get to say.
    expect(source).not.toMatch(/computed_at:|computed_by:/);
  });
});

describe("headlineIsFresh", () => {
  const at = new Date("2026-10-06T12:00:00Z");
  const stored = { engine_version: "1.7.0", revision_ids: ["b", "a"], computed_at: "2026-10-06T11:30:00Z" };
  it("is fresh for the same engine and revisions (in any order) under an hour old", () => {
    expect(headlineIsFresh(stored, { engineVersion: "1.7.0", revisionIds: ["a", "b"], at })).toBe(true);
  });
  it("is stale when the engine, the revisions or the hour changed", () => {
    expect(headlineIsFresh(stored, { engineVersion: "1.8.0", revisionIds: ["a", "b"], at })).toBe(false);
    expect(headlineIsFresh(stored, { engineVersion: "1.7.0", revisionIds: ["a", "c"], at })).toBe(false);
    expect(headlineIsFresh(stored, { engineVersion: "1.7.0", revisionIds: ["a"], at })).toBe(false);
    expect(headlineIsFresh({ ...stored, computed_at: "2026-10-06T10:59:59Z" }, { engineVersion: "1.7.0", revisionIds: ["a", "b"], at })).toBe(false);
  });
});

describe("the agency's workspace table", () => {
  const rows: AgencyWorkspaceRow[] = [
    {
      id: "1",
      name: "Northbeam Digital",
      slug: "northbeam",
      openRiskIssues: 2,
      lastActivity: "2026-10-05T09:00:00Z",
      headline: {
        computedAt: "2026-10-06T08:00:00Z",
        numbers: { flow_efficiency: 0.184, processes_attention: 2, processes_total: 6, client_groups_at_risk: 1, client_groups_total: 3 },
      },
    },
    { id: "2", name: "Larkspur Creative", slug: "larkspur", openRiskIssues: 0, lastActivity: null, headline: null },
  ];
  const html = renderToStaticMarkup(createElement(AgencyWorkspaceTable, { rows }));
  const rowOf = (slug: string) => html.slice(html.indexOf(`data-workspace="${slug}"`)).split("</tr>")[0]!;
  // The RatingPill's markup: a span tinted with the rating's soft colour.
  const pill = /<span[^>]*style="background:var\(--rate-risk-soft\)"[^>]*><i[^>]*><\/i>Operational risk<\/span>/;

  it("has the six columns, each header with an (i)", () => {
    for (const h of ["Workspace", "Flow efficiency", "Processes needing attention", "Open Operational risk issues", "Client groups at risk", "Last activity"]) {
      expect(html, h).toContain(h);
    }
    expect((html.match(/data-slot="help"/g) ?? []).length).toBe(5);
  });

  it("shows the numbers with their date, a link to each workspace, and a prompt where nothing is recorded yet", () => {
    expect(html).toContain('href="/w/northbeam"');
    expect(html).toContain("18%");
    expect(html).toMatch(/<b[^>]*>2<\/b> <span[^>]*>of 6<\/span>/);
    expect(html).toContain("Numbers as of 6 Oct 2026");
    expect(html).toContain("5 Oct 2026");
    expect(html).toContain('href="/w/larkspur"');
    expect(html).toContain("Open the Overview once to see these");
    expect(html).toContain("No activity yet");
  });

  it("shows the Operational risk pill beside a count above zero, and no pill for zero", () => {
    expect(rowOf("northbeam")).toMatch(pill);
    expect(rowOf("larkspur")).not.toMatch(pill);
    expect(rowOf("larkspur")).not.toContain("--rate-risk");
    expect((html.match(/--rate-risk-soft/g) ?? []).length).toBe(1);
  });
});

describe("Client health rules for editors", () => {
  const settings = read("app/w/[slug]/settings/servicing-settings.tsx");
  const health = settings.slice(settings.indexOf("export function HealthSettings"));

  it("HealthSettings gates on canEdit, not canManage, and says who can change them", () => {
    expect(health).toContain("canEdit");
    expect(health).not.toContain("canManage");
    expect(health).toContain("You can view these; owners and editors can change them.");
    expect(health).not.toContain("Only workspace owners can change this.");
  });

  it("saveHealthSetting saves through saveHealthRule (save_health_rules), not the owner-only saveField", () => {
    const actions = read("app/w/[slug]/settings/servicing-actions.ts");
    const fn = actions.slice(actions.indexOf("export async function saveHealthSetting"));
    expect(fn).toContain("saveHealthRule(workspaceId, key, base, value)");
    expect(fn).not.toContain("saveField(");
    expect(read("lib/fields/server.ts")).toContain('supabase.rpc("save_health_rules"');
  });

  it("the Overview records the headline numbers only for editors, at the workspace's own horizon", () => {
    const overview = read("components/overview/overview.tsx");
    expect(overview).toContain("recordHeadline(");
    expect(overview).toMatch(/mode !== "live"/);
    expect(overview).toMatch(/weeks !== live\.workspace\.settings\.horizon_weeks/);
  });

  it("the home page shows the table to agency admins and keeps the cards for everyone else", () => {
    const page = read("app/page.tsx");
    expect(page).toContain("admin && workspaces.length > 0 ? await listAgencyWorkspaces()");
    expect(page).toContain("<AgencyWorkspaceTable");
    expect(page).toContain("grid gap-3 sm:grid-cols-2");
  });
});
