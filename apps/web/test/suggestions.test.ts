import { describe, expect, it } from "vitest";
import {
  describeSuggestion,
  northbeamServiceIds,
  northbeamLeadSourceIds,
  northbeamPersonIds,
  northbeamRoleIds,
  snapshotModel,
  diffSnapshots,
} from "@transpera-flow/db";
import { describeAuditEntry, type AuditEntry } from "@/lib/suggestions/audit";
import { demoBaselineSnapshot, demoCompany, demoProcesses, demoSuggestions } from "@/lib/suggestions/demo";
import { parseReview, reviewInMemory, reviewSummary } from "@/lib/suggestions/review";
import { defaultRunName, parseSaveRun } from "@/lib/runs/runs";

// The Suggestions page's review logic, the change log's wording, the demo's
// sample data and saving runs (issue #25).

const opts = { at: "2026-10-01T09:00:00.000Z", by: "you", newId: () => crypto.randomUUID() };
const state = () => ({ model: demoCompany(), suggestions: demoSuggestions() });
const ids = demoSuggestions().map((s) => s.id);
const pending = demoSuggestions().filter((s) => s.status === "pending");

describe("reviewing in memory", () => {
  it("accepts one: the value changes with its evidence as provenance, and the suggestion records it", () => {
    const [ads] = pending;
    const r = reviewInMemory(state(), [ads!.id], "accept", null, opts);
    expect(r.results).toEqual([{ id: ads!.id, status: "accepted", applied: { target_id: northbeamLeadSourceIds.ads, before: { volume_week: 4 }, after: { volume_week: 6 } } }]);
    const row = r.model.leadSources.find((l) => l.id === northbeamLeadSourceIds.ads)!;
    expect(row.volume_week).toBe(6);
    expect(row.provenance.volume_week).toMatchObject({ source: "estimated", evidence: ads!.evidence, suggestion_id: ads!.id });
    expect(r.suggestions.find((s) => s.id === ads!.id)).toMatchObject({ status: "accepted", reviewed_by: "you", reviewed_at: opts.at });
    // Accepted, it reads with what was there before.
    expect(describeSuggestion(r.suggestions.find((s) => s.id === ads!.id)!, r.model).changes[0]).toMatchObject({ before: "4/wk", after: "6/wk" });
  });

  it("accepts every pending suggestion in bulk; the already-rejected one is reported, not changed", () => {
    const r = reviewInMemory(state(), ids, "accept", null, opts);
    expect(r.results.filter((x) => x.status === "accepted")).toHaveLength(pending.length);
    expect(r.results.filter((x) => x.status === "already_reviewed")).toHaveLength(1);
    expect(r.model.people.find((p) => p.id === northbeamPersonIds["Leah Brooks"])!.fte).toBe(0.9);
    expect(r.model.people.find((p) => p.id === northbeamPersonIds["Arjun Mehta"])!.fte).toBe(0.8);
    expect(r.model.workspace.settings.overtime_cap).toBe(0.15);
    expect(r.model.demand!.growth_monthly).toBe(0.02);
    expect(r.model.seasonality).toEqual([expect.objectContaining({ month: 12, multiplier: 0.6 })]);
    expect(reviewSummary(r.results, "accept")).toBe(`Accepted ${pending.length}. 1 had already been reviewed.`);
  });

  it("rejects with a reason and changes nothing; a suggestion whose row has gone fails and stays pending", () => {
    const s = state();
    const rejected = reviewInMemory(s, [pending[0]!.id], "reject", "Not this week", opts);
    expect(rejected.model).toBe(s.model);
    expect(rejected.suggestions[0]).toMatchObject({ status: "rejected", review_note: "Not this week" });

    const gone = { ...s, model: { ...s.model, services: s.model.services.filter((sv) => sv.id !== northbeamServiceIds.seo) } };
    const harbour = pending.find((p) => p.target_id === northbeamServiceIds.seo)!;
    const r = reviewInMemory(gone, [harbour.id, pending[0]!.id], "accept", null, opts);
    expect(r.results.map((x) => x.status)).toEqual(["failed", "accepted"]);
    expect(r.suggestions.find((x) => x.id === harbour.id)!.status).toBe("pending");
    expect(reviewSummary(r.results, "accept")).toBe("Accepted 1. 1 couldn't be applied and is still pending: What this suggestion changes no longer exists.");
  });

  it("checks review input", () => {
    expect(parseReview([ids[0]], "accept", "  ")).toEqual({ ok: true, ids: [ids[0]], decision: "accept", note: null });
    expect(parseReview([], "accept", null)).toMatchObject({ ok: false });
    expect(parseReview(["x"], "accept", null)).toMatchObject({ ok: false });
    expect(parseReview([ids[0]], "maybe", null)).toMatchObject({ ok: false });
  });
});

describe("the demo's sample data", () => {
  it("reads like the PRD", () => {
    const m = demoCompany();
    const [ads] = pending;
    expect(describeSuggestion(ads!, m).headline).toBe(
      "Claude suggests lead volume 6/wk for Google Ads, was 4/wk, citing “Ads are nearer six a week since we raised the budget.” (Priya Shah)",
    );
    const harbour = pending.find((p) => p.target_id === northbeamServiceIds.seo)!;
    expect(describeSuggestion(harbour, m).changes[0]).toMatchObject({ before: "£3,500", after: "£3,700" });
  });

  it("has a baseline run whose model has changed since, and more once suggestions are accepted", () => {
    const now = snapshotModel(demoCompany(), demoProcesses());
    const before = diffSnapshots(demoBaselineSnapshot(), now).map((c) => c.text);
    expect(before).toEqual([
      "Overtime cap: 0% → 10%",
      "Service SEO retainer: price £3,300 → £3,500",
      "Person added: Chloe Evans",
      "Lead source Google Ads: lead volume 3/wk → 4/wk",
    ]);
    const accepted = reviewInMemory(state(), ids, "accept", null, opts).model;
    const after = diffSnapshots(demoBaselineSnapshot(), snapshotModel(accepted, demoProcesses())).map((c) => c.text);
    expect(after).toContain("Person Leah Brooks: FTE 1 → 0.9");
    expect(after).toContain("Person Arjun Mehta: FTE 1 → 0.8");
    expect(after).toContain("Demand growth: 0% a month → 2% a month");
  });
});

describe("the change log", () => {
  const m = demoCompany();
  const entry = (e: Partial<AuditEntry>): AuditEntry => ({
    id: "a",
    created_at: "2026-10-01T09:00:00Z",
    actor_id: "u",
    actor_kind: "user",
    action: "update",
    target_table: "people",
    target_id: northbeamPersonIds["Sam Patel"]!,
    diff: {},
    ...e,
  });
  it("tells each company-model write in plain words", () => {
    expect(describeAuditEntry(entry({ diff: { old: { fte: 1 }, new: { fte: 0.6 } } }), m)).toBe("Person Sam Patel: FTE 1 → 0.6");
    expect(describeAuditEntry(entry({ target_table: "workspaces", diff: { old: { settings: { overtime_cap: 0.1 } }, new: { settings: { overtime_cap: 0.2 } } } }), m)).toBe(
      "Company settings: Overtime cap 10% → 20%",
    );
    expect(describeAuditEntry(entry({ target_table: "lead_sources", action: "insert", diff: { new: { name: "Podcast" } } }), m)).toBe("Added lead source Podcast");
    expect(
      describeAuditEntry(entry({ target_table: "person_roles", action: "delete", diff: { old: { person_id: northbeamPersonIds["Sam Patel"] }, role_id: northbeamRoleIds.seo } }), m),
    ).toBe("Sam Patel: role SEO specialist removed");
    expect(
      describeAuditEntry(entry({ target_table: "suggestions", action: "rejected", diff: { old: { status: "pending" }, new: { status: "rejected", review_note: "No" } } }), m),
    ).toBe("Rejected a suggested change to the company model: “No”");
  });

  it("tells branding changes (issue #34): colours by value, the logo never by its storage path", () => {
    const WS = "0d5f6f0e-0000-4000-8000-000000000001";
    const logo = (n: number) => `${WS}/00000000-0000-4000-8000-00000000000${n}.png`;
    const say = (oldB: unknown, newB: unknown, extra: { old?: object; new?: object } = {}) =>
      describeAuditEntry(entry({ target_table: "workspaces", diff: { old: { branding: oldB, ...extra.old }, new: { branding: newB, ...extra.new } } }), m);
    expect(say({}, { accent: "#0b6e8a" })).toBe("Branding: accent colour default → #0b6e8a");
    expect(say({ accent: "#0b6e8a" }, { accent: "#7a1fa2" })).toBe("Branding: accent colour #0b6e8a → #7a1fa2");
    expect(say({ accent: "#0b6e8a" }, { accent: null })).toBe("Branding: accent colour #0b6e8a → default");
    expect(say({ accent: "#0b6e8a" }, { accent: "#0b6e8a", accent_dark: "#4cc3e0" })).toBe("Branding: dark-mode accent → #4cc3e0");
    expect(say({ accent: "#0b6e8a", accent_dark: "#4cc3e0" }, { accent: "#0b6e8a", accent_dark: null })).toBe("Branding: dark-mode accent → automatic");
    expect(say({}, { logo_path: logo(1) })).toBe("Branding: logo added");
    expect(say({ logo_path: logo(1) }, { logo_path: logo(2) })).toBe("Branding: logo changed");
    expect(say({ logo_path: logo(1) }, {})).toBe("Branding: logo removed");
    expect(say({ logo_path: logo(1) }, { logo_path: null })).toBe("Branding: logo removed");
    for (const s of [say({}, { logo_path: logo(1) }), say({ logo_path: logo(1) }, { logo_path: logo(2) })]) expect(s).not.toContain(WS);
    // Beside another setting, it joins the company settings line.
    expect(say({}, { accent: "#0b6e8a" }, { old: { settings: { overtime_cap: 0.1 } }, new: { settings: { overtime_cap: 0.2 } } })).toBe(
      "Company settings: Overtime cap 10% → 20%, accent colour default → #0b6e8a",
    );
    // Nothing about branding changed: the old wording stands.
    expect(say({}, {})).toBe("Company settings updated");
  });
});

describe("saving runs", () => {
  const stat = { mean: 1, p10: 0, p90: 2 };
  const input = {
    name: "  Baseline  ",
    processId: "c0000000-0000-4000-8000-000000000001",
    revisionId: "d0000000-0000-4000-8000-000000000001",
    results: { horizon_weeks: 13, hours_per_week: 40, currency: "GBP", reps: 30, won: stat, lost: stat, cycle: { mean: 1, p50: 1, p90: 2 }, mrr_added: stat, billed: stat, overtime_hours: stat, bottleneck: null },
    seed: 1,
    reps: 30,
    durationMs: 812.4,
    engineVersion: "1.0.0",
  };
  it("checks what the page sends", () => {
    expect(parseSaveRun(input)).toMatchObject({ ok: true, value: { name: "Baseline", durationMs: 812 } });
    expect(parseSaveRun({ ...input, name: " " })).toMatchObject({ ok: false });
    expect(parseSaveRun({ ...input, results: { ...input.results, won: { mean: "x" } } })).toMatchObject({ ok: false });
    expect(parseSaveRun({ ...input, processId: "nope" })).toMatchObject({ ok: false });
  });
  it("records the engine version the results came from (issue #22)", () => {
    expect(parseSaveRun(input)).toMatchObject({ ok: true, value: { engineVersion: "1.0.0" } });
    // A page loaded before runs recorded it still saves, with none.
    expect(parseSaveRun({ ...input, engineVersion: undefined })).toMatchObject({ ok: true, value: { engineVersion: null } });
    expect(parseSaveRun({ ...input, engineVersion: "latest; drop table runs" })).toMatchObject({ ok: false });
    expect(parseSaveRun({ ...input, engineVersion: 1 })).toMatchObject({ ok: false });
  });
  it("names a run by when it was saved", () => {
    expect(defaultRunName(new Date(2026, 8, 30, 14, 5))).toBe("Run 30 Sept 2026, 14:05");
  });
});
