import { describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import {
  changesSinceRun,
  companyOf,
  diffSnapshots,
  formatCompanyValue,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  northbeamBundle,
  northbeamClientIds,
  northbeamLeadSourceIds,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamServiceIds,
  runResults,
  snapshotModel,
  toEngineModel,
  type CompanyModel,
} from "../src";

// The company model's pure parts (issue #25): snapshots of it and what changed
// since one. No database. (How a suggestion read and applied was tested here until Suggestions were removed.)

const northbeam = () => companyOf(northbeamBundle());
const processes = [{ id: NORTHBEAM_PROCESS_ID, name: "Lead to Cash", revision_id: NORTHBEAM_REVISION_ID, revision: 1 }];
const sam = northbeamPersonIds["Sam Patel"]!;
const chloe = northbeamPersonIds["Chloe Evans"]!;
const client = northbeamClientIds.c01!;

describe("formatCompanyValue", () => {
  it("shows values the way people read them", () => {
    expect(formatCompanyValue("money", 3500, "GBP")).toBe("£3,500");
    expect(formatCompanyValue("percent", 0.035)).toBe("3.5%");
    expect(formatCompanyValue("perWeek", 15)).toBe("15/wk");
    expect(formatCompanyValue("multiplier", 1.2)).toBe("×1.2");
    expect(formatCompanyValue("fte", 0.8)).toBe("0.8");
    expect(formatCompanyValue("hours", 32)).toBe("32 h/wk");
    expect(formatCompanyValue("bool", false)).toBe("no");
    expect(formatCompanyValue("money", null)).toBe("not set");
  });
});

describe("snapshots and what changed since a run", () => {
  it("finds nothing changed in an unchanged model", () => {
    const a = snapshotModel(northbeam(), processes);
    expect(diffSnapshots(a, snapshotModel(northbeam(), processes))).toEqual([]);
    // It survives a round trip through jsonb.
    expect(diffSnapshots(JSON.parse(JSON.stringify(a)), a)).toEqual([]);
  });

  it("lists each change in plain words: settings, demand, a new revision, and rows added, removed and changed", () => {
    const before = snapshotModel(northbeam(), processes);
    const m = northbeam();
    const now: CompanyModel = {
      ...m,
      workspace: { ...m.workspace, settings: { ...m.workspace.settings, overtime_cap: 0.2 } },
      leadSources: m.leadSources.map((l) => (l.id === northbeamLeadSourceIds.ads ? { ...l, volume_week: 15 } : l)),
      people: [
        ...m.people.filter((p) => p.id !== chloe).map((p) => (p.id === sam ? { ...p, fte: 0.6 } : p)),
        { ...m.people[0]!, id: "jo", name: "Jo Smith" },
      ],
      personRoles: m.personRoles.filter((r) => !(r.person_id === sam && r.role_id === northbeamRoleIds.seo)),
      clientAssignments: m.clientAssignments.map((a) =>
        a.client_id === client && a.role_id === northbeamRoleIds.seo ? { ...a, person_id: northbeamPersonIds["Leah Brooks"]! } : a,
      ),
      seasonality: [{ id: "dec", workspace_id: m.workspace.id, month: 12, multiplier: 0.6, provenance: {} }],
      demand: { ...m.demand!, growth_monthly: 0.02 },
    };
    const later = [{ ...processes[0]!, revision_id: "rev-2", revision: 2 }];
    const texts = diffSnapshots(before, snapshotModel(now, later)).map((c) => c.text);
    expect(texts).toEqual([
      "Overtime cap: 10% → 20%",
      "Demand growth: 0% a month → 2% a month",
      "Seasonality in December: ×1 → ×0.6",
      "Lead to Cash: revision 2 published since this run used revision 1",
      "Person removed: Chloe Evans",
      "Person added: Jo Smith",
      "Person Sam Patel: FTE 1 → 0.6",
      "Person Sam Patel: roles SEO specialist → none",
      "Client Harbour Lane Dental: SEO specialist Sam Patel → Leah Brooks",
      "Lead source Google Ads: lead volume 4/wk → 15/wk",
    ]);
  });

  it("keeps a run's results and compares its snapshot with the model now", () => {
    const bundle = northbeamBundle();
    const model = toEngineModel(bundle, { startDate: "2026-10-05" });
    const results = runResults(model, simulate(model, 5, 1), "GBP");
    expect(results).toMatchObject({ horizon_weeks: model.horizonWeeks, reps: 5, currency: "GBP" });
    expect(results.bottleneck?.role).toBeTruthy();
    const run = { params_snapshot: snapshotModel(companyOf(bundle), processes) };
    const changed = northbeam();
    changed.services = changed.services.map((s) => (s.id === northbeamServiceIds.seo ? { ...s, price: 3800 } : s));
    expect(changesSinceRun(run, snapshotModel(changed, processes)).map((c) => c.text)).toEqual(["Service SEO retainer: price £3,500 → £3,800"]);
  });
});
