import { describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import {
  applySuggestion,
  changesSinceRun,
  companyOf,
  describeSuggestion,
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
  northbeamSourceIds,
  patchProblem,
  runResults,
  snapshotModel,
  SuggestionError,
  toEngineModel,
  type CompanyModel,
  type SuggestionPatch,
  type SuggestionRow,
  type SuggestionTarget,
} from "../src";

// The company model's pure parts (issue #25): snapshots of it and what changed
// since one, and how a suggestion reads and applies. No database.

const northbeam = () => companyOf(northbeamBundle());
const processes = [{ id: NORTHBEAM_PROCESS_ID, name: "Lead to Cash", revision_id: NORTHBEAM_REVISION_ID, revision: 1 }];
const sam = northbeamPersonIds["Sam Patel"]!;
const chloe = northbeamPersonIds["Chloe Evans"]!;
const client = northbeamClientIds.c01!;

let n = 0;
function suggestion(target: SuggestionTarget, targetId: string | null, patch: SuggestionPatch, extra: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id: `s-${++n}`,
    workspace_id: northbeamBundle().workspace.id,
    target_table: target,
    target_id: targetId,
    patch,
    evidence: [],
    note: null,
    status: "pending",
    created_via: "mcp",
    import_source: null,
    applied: null,
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: "2026-10-15T09:00:00Z",
    created_by: null,
    ...extra,
  };
}

const apply = (model: CompanyModel, s: SuggestionRow) => applySuggestion(model, s, { at: "2026-10-15T10:00:00Z", by: "u1", newId: () => `new-${++n}` });

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

describe("describeSuggestion", () => {
  const evidence = [{ source_id: northbeamSourceIds.salesNotes, speaker: "Priya Shah", quote: "Ads bring in fifteen a week now" }];

  it("reads like the PRD's example: the new value, what it was, and the quote", () => {
    const s = suggestion("lead_sources", northbeamLeadSourceIds.ads, { set: { volume_week: 15 } }, { evidence });
    const v = describeSuggestion(s, northbeam());
    expect(v.headline).toBe("Claude suggests lead volume 15/wk for Google Ads, was 4/wk, citing “Ads bring in fifteen a week now” (Priya Shah)");
    expect(v).toMatchObject({ subject: "Lead source Google Ads", action: "update", missing: false });
    expect(v.changes).toEqual([{ field: "volume_week", label: "Lead volume", before: "4/wk", after: "15/wk", unchanged: false, overridesFact: false }]);
  });

  it("describes a new person with roles and leave", () => {
    const s = suggestion("people", null, {
      set: { name: "Jo Smith", fte: 0.8 },
      roles: [northbeamRoleIds.seo],
      leave: [{ start_date: "2026-12-21", end_date: "2027-01-01" }],
    });
    const v = describeSuggestion(s, northbeam());
    expect(v.subject).toBe("New person Jo Smith");
    expect(v.headline).toBe("Claude suggests adding person Jo Smith (FTE 0.8, roles SEO specialist, leave 2026-12-21 to 2027-01-01)");
    expect(v.changes.every((c) => c.before === null)).toBe(true);
  });

  it("warns when accepting would override an entered value, and flags values that already match", () => {
    const m = northbeam();
    // Harbour Lane Dental's MRR was entered from the invoices.
    const s = suggestion("clients", client, { set: { mrr: 4000, health: 88 }, assignments: { [northbeamRoleIds.seo]: chloe } });
    const v = describeSuggestion(s, m);
    expect(v.changes).toEqual([
      { field: "mrr", label: "MRR", before: "£3,500", after: "£4,000", unchanged: false, overridesFact: true },
      { field: "health", label: "Health", before: "88", after: "88", unchanged: true, overridesFact: false },
      { field: `assignments.${northbeamRoleIds.seo}`, label: "SEO specialist", before: "Sam Patel", after: "Chloe Evans", unchanged: false, overridesFact: false },
    ]);
    expect(v.headline).toBe("Claude suggests MRR £4,000 for Harbour Lane Dental, was £3,500 (and 1 more change)");
  });

  it("uses what was there when it was accepted, and notices a target that has gone", () => {
    const s = suggestion(
      "lead_sources",
      northbeamLeadSourceIds.ads,
      { set: { volume_week: 15 } },
      { status: "accepted", applied: { target_id: northbeamLeadSourceIds.ads, before: { volume_week: 4 }, after: { volume_week: 15 } } },
    );
    const m = northbeam();
    const accepted = apply(m, { ...s, status: "pending", applied: null }).model;
    expect(describeSuggestion(s, accepted).changes[0]).toMatchObject({ before: "4/wk", after: "15/wk" });
    const gone = { ...m, leadSources: m.leadSources.filter((l) => l.id !== northbeamLeadSourceIds.ads) };
    expect(describeSuggestion({ ...s, status: "pending", applied: null }, gone).missing).toBe(true);
  });

  it("describes a new role and a rename", () => {
    const created = describeSuggestion(suggestion("roles", null, { set: { name: "Copywriter" } }), northbeam());
    expect(created.subject).toBe("New role Copywriter");
    expect(created.headline).toMatch(/^Claude suggests adding role Copywriter/);
    const renamed = describeSuggestion(suggestion("roles", northbeamRoleIds.fin, { set: { name: "Finance and admin" } }), northbeam());
    expect(renamed.headline).toMatch(/renaming to/);
    expect(renamed.headline).toMatch(/was Finance/);
  });

  it("names company settings, demand growth and a seasonality month", () => {
    const m = northbeam();
    expect(describeSuggestion(suggestion("workspaces", null, { set: { hours_per_week: 37.5 } }), m).headline).toBe(
      "Claude suggests working hours a week 37.5, was 40",
    );
    expect(describeSuggestion(suggestion("demand_settings", null, { set: { growth_monthly: 0.02 } }), m).headline).toBe(
      "Claude suggests growth a month 2%, was 0%",
    );
    const dec = describeSuggestion(suggestion("seasonality", null, { set: { month: 12, multiplier: 0.6 } }), m);
    expect(dec.subject).toBe("Seasonality: December");
    expect(dec.headline).toBe("Claude suggests seasonality in December ×0.6, was ×1");
  });
});

describe("applySuggestion", () => {
  it("creates a role with the database's defaults", () => {
    const { model, applied } = apply(northbeam(), suggestion("roles", null, { set: { name: "Copywriter" } }));
    const role = model.roles.find((r) => r.name === "Copywriter")!;
    expect(role).toMatchObject({ color: null, default_cost_rate: 0, headcount: 1, ongoing_hours_per_client_week: 0, active: true, provenance: {} });
    expect(applied).toEqual({ target_id: role.id, before: null, after: { name: "Copywriter" } });
  });

  it("applies with provenance from the evidence, leaving other values alone", () => {
    const evidence = [{ source_id: northbeamSourceIds.salesNotes, speaker: "Priya Shah", quote: "fifteen a week", value: 15 }];
    const s = suggestion("lead_sources", northbeamLeadSourceIds.ads, { set: { volume_week: 15 } }, { evidence, note: "Weekly figure" });
    const { model, applied } = apply(northbeam(), s);
    const ads = model.leadSources.find((l) => l.id === northbeamLeadSourceIds.ads)!;
    expect(ads.volume_week).toBe(15);
    expect(ads.provenance.volume_week).toEqual({ source: "estimated", at: "2026-10-15T10:00:00Z", by: "u1", note: "Weekly figure", evidence, suggestion_id: s.id });
    expect(ads.provenance.conversion_to_qualified).toEqual(northbeam().leadSources.find((l) => l.id === northbeamLeadSourceIds.ads)!.provenance.conversion_to_qualified);
    expect(applied).toEqual({ target_id: northbeamLeadSourceIds.ads, before: { volume_week: 4 }, after: { volume_week: 15 } });
  });

  it("refuses fields that can't be suggested and targets that are gone", () => {
    expect(patchProblem("people", { set: { workspace_id: "x" } })).toMatch(/can't be suggested/);
    expect(patchProblem("services", { set: {}, roles: [] })).toMatch(/doesn't apply/);
    expect(() => apply(northbeam(), suggestion("people", "nobody", { set: { fte: 1 } }))).toThrow(SuggestionError);
  });
});
