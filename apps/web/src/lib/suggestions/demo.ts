// The public demo's company-model suggestions and saved run (issue #25):
// what Claude might have suggested after Northbeam's audit interviews (the
// quotes are fictional, like the sample), and a run saved before some of the
// model changed, so its "model changed since this run" banner has something
// to list. Accepting a suggestion on /demo/suggestions changes the model the
// demo's saved runs are compared with (lib/demo/company-store.ts).

import {
  companyOf,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamBundle,
  northbeamIssues,
  northbeamStepIds,
  northbeamLeadSourceIds,
  northbeamPersonIds,
  northbeamServiceIds,
  northbeamSourceIds,
  snapshotModel,
  type CompanyModel,
  type ModelSnapshot,
  type ProcessBundle,
  type ProposalRow,
  type SnapshotProcess,
  type SuggestionPatch,
  type SuggestionRow,
  type SuggestionTarget,
} from "@transpera-flow/db";

const id = (n: number) => `5a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const person = (name: string) => northbeamPersonIds[name]!;
const { salesNotes, strategyInterview } = northbeamSourceIds;

function row(
  n: number,
  target: SuggestionTarget,
  targetId: string | null,
  patch: SuggestionPatch,
  extra: Partial<SuggestionRow> = {},
): SuggestionRow {
  return {
    id: id(n),
    workspace_id: NORTHBEAM_WORKSPACE_ID,
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
    created_at: `2026-09-30T09:${String(10 + n).padStart(2, "0")}:00.000Z`,
    created_by: null,
    ...extra,
  };
}

/** Northbeam's sample suggestions: pending ones to review, and one already turned down. */
export function demoSuggestions(): SuggestionRow[] {
  return [
    row(1, "lead_sources", northbeamLeadSourceIds.ads, { set: { volume_week: 6 } }, {
      evidence: [{ source_id: salesNotes, speaker: "Priya Shah", quote: "Ads are nearer six a week since we raised the budget.", timestamp: null, value: 6 }],
      note: "Priya's figure for leads from Google Ads since the budget went up.",
    }),
    row(2, "people", person("Arjun Mehta"), { set: { fte: 0.8 } }, {
      evidence: [{ source_id: strategyInterview, speaker: "Maya Collins", quote: "Arjun moves to four days a week from November.", timestamp: "00:25:30", value: 0.8 }],
      note: "Four days out of five.",
    }),
    row(3, "people", person("Leah Brooks"), { set: { fte: 0.9 } }, {
      evidence: [{ source_id: strategyInterview, speaker: "Maya Collins", quote: "Leah drops a half day a week from November.", timestamp: "00:27:10", value: 0.9 }],
      note: "Nine tenths of a full-time week.",
    }),
    row(4, "services", northbeamServiceIds.seo, { set: { price: 3700 } }, {
      evidence: [{ source_id: salesNotes, speaker: "Tom Reed", quote: "New SEO clients are on 3,700 now.", timestamp: null, value: 3700 }],
    }),
    row(5, "services", northbeamServiceIds.ppc, { set: { price: 4500 } }, {
      evidence: [{ source_id: salesNotes, speaker: "Tom Reed", quote: "New PPC clients are on 4,500 now.", timestamp: null, value: 4500 }],
    }),
    row(6, "workspaces", null, { set: { overtime_cap: 0.15 } }, {
      note: "Maya said people “stay late most weeks”; 15% of capacity is a guess, not a figure anyone gave.",
    }),
    row(7, "seasonality", null, { set: { month: 12, multiplier: 0.6 } }, {
      evidence: [{ source_id: salesNotes, speaker: "Priya Shah", quote: "December is dead, maybe half the usual enquiries.", timestamp: null, value: 0.5 }],
      note: "“Maybe half”: 0.6 allows for the ones that still come in.",
    }),
    row(8, "demand_settings", null, { set: { growth_monthly: 0.02 } }, {
      evidence: [{ source_id: strategyInterview, speaker: "Maya Collins", quote: "We're growing a couple of percent a month, give or take.", timestamp: "00:31:02", value: 0.02 }],
    }),
    row(9, "lead_sources", northbeamLeadSourceIds.referrals, { set: { volume_week: 5 } }, {
      evidence: [{ source_id: salesNotes, speaker: "Tom Reed", quote: "Referrals were five a week in August.", timestamp: null, value: 5 }],
      status: "rejected",
      review_note: "August was a one-off; three a week is right.",
      reviewed_at: "2026-09-30T10:05:00.000Z",
      created_at: "2026-09-30T09:05:00.000Z",
    }),
  ];
}

/**
 * Northbeam's sample proposals: an issue to accept or reject, and an idea for the open issue about lead scoring. Fictional,
 * like the quotes above (A52).
 */
export function demoProposals(): ProposalRow[] {
  const [, , scoring] = northbeamIssues();
  const base = {
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    note: null,
    status: "pending" as const,
    created_via: "mcp" as const,
    import_source: null,
    proposer_name: null,
    share_link_id: null,
    applied: null,
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    created_by: null,
  };
  return [
    {
      ...base,
      id: id(21),
      kind: "solution_idea",
      title: "Fast-track partner leads past the fit check",
      detail: "Partner leads convert twice as well as website leads. Let them skip the fit check and go straight to booking a call.",
      payload: {
        steps: [
          { key: "s1", name: "Partner lead arrives", kind: "task" },
          { key: "s2", name: "Book discovery call", role: "Sales" },
          { key: "s3", name: "Quick check by AI", ai: true },
        ],
        edges: [
          { from: "s1", to: "s2" },
          { from: "s2", to: "s3" },
        ],
        replaces_step_ids: [northbeamStepIds.qualify],
        expect: "AI expects first contact for partner leads under 2 h.",
      },
      evidence: [],
      issue_id: scoring!.id,
      created_at: "2026-09-30T09:31:00.000Z",
    },
    {
      ...base,
      id: id(22),
      kind: "issue",
      title: "Leads wait a day for a discovery call",
      detail: "Priya says most discovery calls are booked for the next day, and some leads go cold.",
      payload: {
        severity: "warning",
        type: "delay",
        links: [{ process_id: NORTHBEAM_PROCESS_ID, step_id: northbeamStepIds.discovery }],
        target_measure: "Wait before Discovery call",
        target_now: "24 h",
        target_goal: "under 8 h",
      },
      evidence: [{ source_id: salesNotes, speaker: "Priya Shah", quote: "Most discovery calls are booked for the next day.", timestamp: null }],
      issue_id: null,
      created_at: "2026-09-30T09:32:00.000Z",
    },
  ];
}

/** The process revision the demo's runs use. */
export function demoProcesses(bundle: ProcessBundle = northbeamBundle()): SnapshotProcess[] {
  return [{ id: bundle.process.id, name: bundle.process.name, revision_id: bundle.revision.id, revision: bundle.revision.number }];
}

/** The model the demo starts with. */
export function demoCompany(): CompanyModel {
  return companyOf(northbeamBundle());
}

/**
 * The snapshot of the demo's saved "Audit baseline" run: the model two days
 * before, when overtime wasn't allowed, the SEO retainer was 3,300, Google Ads
 * brought 3 leads a week and Chloe Evans hadn't joined.
 */
export function demoBaselineSnapshot(): ModelSnapshot {
  const m = demoCompany();
  const chloe = person("Chloe Evans");
  const earlier: CompanyModel = {
    ...m,
    workspace: { ...m.workspace, settings: { ...m.workspace.settings, overtime_cap: 0 } },
    services: m.services.map((s) => (s.id === northbeamServiceIds.seo ? { ...s, price: 3300 } : s)),
    leadSources: m.leadSources.map((l) => (l.id === northbeamLeadSourceIds.ads ? { ...l, volume_week: 3 } : l)),
    people: m.people.filter((p) => p.id !== chloe),
    personRoles: m.personRoles.filter((r) => r.person_id !== chloe),
  };
  return snapshotModel(earlier, demoProcesses());
}
