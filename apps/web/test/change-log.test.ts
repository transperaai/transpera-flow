import { describe, expect, it } from "vitest";
import { companyOf, northbeamBundle, northbeamPersonIds, northbeamRoleIds, northbeamServiceIds, northbeamStepIds } from "@transpera-flow/db";
import { auditStepId, auditStepIds, describeAuditEntry, newestStepNames, type AuditEntry } from "@/lib/change-log/audit";
import { defaultRunName, parseSaveRun } from "@/lib/runs/runs";

// The change log's wording (Settings → Change log) and saving runs. Ported from the Suggestions page's test (removed 28 Oct 2026,
// docs/plans/cut-list.md): the review logic and the demo's sample suggestions went with the page; the log's wording stayed.

describe("the change log", () => {
  const m = companyOf(northbeamBundle());
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
  });

  it("tells a per-person time (C6, #230) in words, names its step, and never states the number", () => {
    const sam = northbeamPersonIds["Sam Patel"];
    const kickoff = northbeamStepIds.kickoff;
    const stepNames = { [kickoff]: "Kickoff", [northbeamStepIds.audit]: "Audit" };
    const say = (action: string, diff: AuditEntry["diff"], names: Record<string, string> = stepNames) =>
      describeAuditEntry(entry({ target_table: "person_capacity_factors", action, target_id: sam, diff }), m, names);
    // An entry logged before #230 has no step on an update: today's wording, never a guess.
    expect(say("update", { old: { factor: 0.8 }, new: { factor: 1.3 } })).toBe("Sam Patel: a per-person time changed");
    // A step: the top-level key (#230), or inside the whole row an insert or delete logs.
    expect(say("insert", { step_id: kickoff, new: { person_id: sam, step_id: kickoff, factor: 0.8 } })).toBe("Sam Patel: per-person time on Kickoff set");
    expect(say("update", { step_id: kickoff, old: { factor: 0.8 }, new: { factor: 1.3 } })).toBe("Sam Patel: per-person time on Kickoff changed");
    expect(say("delete", { old: { person_id: sam, step_id: kickoff, factor: 1.3 } })).toBe("Sam Patel: per-person time on Kickoff removed");
    expect(say("delete", { step_id: kickoff, old: { person_id: sam, factor: 1.3 } })).toBe("Sam Patel: per-person time on Kickoff removed");
    // Every step: the explicit key, or (old entries) an insert or delete with no step anywhere.
    expect(say("update", { every_step: true, old: { factor: 0.8 }, new: { factor: 1.3 } })).toBe("Sam Patel: per-person time for every step changed");
    expect(say("insert", { every_step: true, new: { person_id: sam, factor: 0.8 } })).toBe("Sam Patel: per-person time for every step set");
    expect(say("insert", { new: { person_id: sam, factor: 0.8 } })).toBe("Sam Patel: per-person time for every step set");
    expect(say("delete", { old: { person_id: sam, factor: 1.3 } })).toBe("Sam Patel: per-person time for every step removed");
    // A step that is in no process any more, or no names given at all.
    expect(say("insert", { step_id: "00000000-0000-4000-8000-000000000000", new: { factor: 0.8 } })).toBe("Sam Patel: per-person time on a step no longer in any process set");
    expect(say("insert", { step_id: kickoff, new: { factor: 0.8 } }, {})).toBe("Sam Patel: per-person time on a step no longer in any process set");
    // Measured times (#227) say so; entered ones don't.
    expect(say("insert", { step_id: kickoff, new: { factor: 0.9, provenance: { factor: { source: "measured", at: "2026-10-01" } } } })).toBe("Sam Patel: per-person time on Kickoff set (measured)");
    expect(say("insert", { step_id: kickoff, new: { factor: 0.9, provenance: { factor: { source: "entered", by: "u" } } } })).toBe("Sam Patel: per-person time on Kickoff set");
    expect(say("insert", { step_id: kickoff, new: { factor: 0.9, provenance: "measured" } })).toBe("Sam Patel: per-person time on Kickoff set");
    // A measured update from before #230 has no step, but still says it was measured.
    expect(say("update", { old: { factor: 0.8 }, new: { factor: 0.9, provenance: { factor: { source: "measured" } } } })).toBe("Sam Patel: a per-person time changed (measured)");
    // every_step wins over a stray step id inside the row.
    expect(say("insert", { every_step: true, new: { person_id: sam, step_id: kickoff, factor: 0.8 } })).toBe("Sam Patel: per-person time for every step set");
    // Never the number, and never anyone else's name.
    const texts = [
      say("insert", { step_id: kickoff, new: { person_id: sam, step_id: kickoff, factor: 0.8 } }),
      say("update", { step_id: kickoff, old: { factor: 0.8 }, new: { factor: 1.3 } }),
      say("update", { every_step: true, old: { factor: 0.8 }, new: { factor: 1.3 } }),
      say("update", { old: { factor: 0.8 }, new: { factor: 1.3 } }),
      say("delete", { old: { person_id: sam, factor: 1.3 } }),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/0\.8|1\.3/);
      expect(text).not.toContain("Rosa Diaz");
    }
  });

  it("names the step of a skill (#230), and keeps today's wording without one", () => {
    const sam = northbeamPersonIds["Sam Patel"];
    const kickoff = northbeamStepIds.kickoff;
    const say = (action: string, diff: AuditEntry["diff"]) =>
      describeAuditEntry(entry({ target_table: "person_skills", action, target_id: sam, diff }), m, { [kickoff]: "Kickoff" });
    expect(say("insert", { step_id: kickoff, new: { person_id: sam, step_id: kickoff } })).toBe("Sam Patel: skill Kickoff added");
    expect(say("delete", { step_id: kickoff, old: { person_id: sam, step_id: kickoff } })).toBe("Sam Patel: skill Kickoff removed");
    expect(say("update", { step_id: kickoff, old: { efficiency: 1 }, new: { efficiency: 1.2 } })).toBe("Sam Patel: skill Kickoff changed");
    expect(say("insert", { new: { person_id: sam } })).toBe("Sam Patel: a skill added");
    expect(say("update", { old: { efficiency: 1 }, new: { efficiency: 1.2 } })).toBe("Sam Patel: a skill changed");
  });

  it("collects the step ids the log names, once each, and takes the newest revision's name", () => {
    const [a, b] = [northbeamStepIds.kickoff, northbeamStepIds.audit];
    const ids = auditStepIds([
      entry({ target_table: "person_capacity_factors", diff: { step_id: a } }),
      entry({ target_table: "person_skills", diff: { new: { step_id: a } } }),
      entry({ target_table: "person_capacity_factors", action: "delete", diff: { old: { step_id: b } } }),
      entry({ target_table: "person_capacity_factors", diff: { every_step: true } }),
      entry({ target_table: "people", diff: { step_id: "ignored-table" } }),
    ]);
    expect(ids).toEqual([a, b]);
    // `steps` has a row per revision, newest first: the first name per id wins (a rename shows its newest name).
    expect(
      newestStepNames([
        { id: a, name: "Kick-off call" },
        { id: b, name: "Audit" },
        { id: a, name: "Kickoff" },
      ]),
    ).toEqual({ [a]: "Kick-off call", [b]: "Audit" });
    expect(newestStepNames([])).toEqual({});
  });

  it("auditStepId reads diff.step_id, then new.step_id, then old.step_id", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const c = "33333333-3333-4333-8333-333333333333";
    expect(auditStepId({ diff: { step_id: a, new: { step_id: b }, old: { step_id: c } } })).toBe(a);
    expect(auditStepId({ diff: { new: { step_id: b }, old: { step_id: c } } })).toBe(b);
    expect(auditStepId({ diff: { old: { step_id: c } } })).toBe(c);
    expect(auditStepId({ diff: { new: { step_id: null } } })).toBeNull();
    expect(auditStepId({ diff: { every_step: true } })).toBeNull();
    expect(auditStepId({ diff: {} })).toBeNull();
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
    // Since step 4 the logo is a row of workspace_logos, and the database logs its hash (never shown) in the same place.
    const sha = (n: number) => String(n).repeat(64);
    expect(say({}, { logo_sha256: sha(1) })).toBe("Branding: logo added");
    expect(say({ logo_sha256: sha(1) }, { logo_sha256: sha(2) })).toBe("Branding: logo changed");
    expect(say({ logo_sha256: sha(1) }, {})).toBe("Branding: logo removed");
    for (const s of [say({}, { logo_sha256: sha(1) }), say({ logo_sha256: sha(1) }, { logo_sha256: sha(2) })]) expect(s).not.toContain(sha(1).slice(0, 12));
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
