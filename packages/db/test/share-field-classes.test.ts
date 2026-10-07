import type { FpDeleteCandidate, FpImprovement, FpMeasure, FpRequirement, FpStatement, ScenarioPatch } from "@transpera-flow/engine";
import { describe, expect, it } from "vitest";
import type { Database } from "../src";
import type { Viewer } from "../src/queries";
import { SHARE_NON_TEXT_KEYS, SHARE_NON_TEXT_REASONS, type IssueShare, type OverviewShare, type ProcessShare, type SolutionShare } from "../src/share";
import type { BlockBundle, FindingCitation, FindingRow, IssueLinkRef, IssueRow, RecurrenceJson, SolutionsData, WorkspaceSettings } from "../src/types";

// Every string column of every table, from the generated database types, is classified here: free text, or not text (an id, a date,
// an enum the engine reads), or the whole table is "unused" (its rows never reach a share link). The maps are exhaustive at the type
// level: add a column or a table (regenerate database.types.ts) and this file stops compiling until the new one is classified, so a
// new field can't ship unclassified; the share link scrubs any string under a key not on SHARE_NON_TEXT_KEYS (default deny) either
// way. The nested shapes the snapshot carries (the first-principles document) are classified the same way below.

type Tables = Database["public"]["Tables"];
/** Free text; not text (its key is on SHARE_NON_TEXT_KEYS); or always a uuid or null, which both checks skip whatever its key. */
type Class = "text" | "not" | "uuid";
type StrKeys<T> = { [K in keyof T]-?: NonNullable<T[K]> extends string | string[] ? K : never }[keyof T];
type Cols<K extends keyof Tables> = StrKeys<Tables[K]["Row"]>;
type TableClasses = { [K in keyof Tables]: "unused" | { [C in Cols<K>]: Class } };

const TABLES: TableClasses = {
  ai_analyses: "unused",
  ai_runs: "unused",
  ai_settings: "unused",
  analysis_rules: "unused",
  api_tokens: "unused",
  audit_log: "unused",
  calibrations: "unused",
  churn_drivers: { created_at: "not", created_by: "not", description: "text", driver: "not", example: "text", id: "not", name: "text", updated_at: "not", workspace_id: "not" },
  blocks: "unused",
  client_assignments: { client_id: "not", created_at: "not", person_id: "not", role_id: "not", updated_at: "not", workspace_id: "not" },
  client_groups: { created_at: "not", created_by: "not", id: "not", service_id: "not", updated_at: "not", workspace_id: "not" },
  client_services: { client_id: "not", created_at: "not", service_id: "not", start_date: "not", workspace_id: "not" },
  clients: { created_at: "not", created_by: "not", id: "not", name: "text", notes: "text", start_date: "not", updated_at: "not", workspace_id: "not" },
  datasets: "unused",
  demand_settings: { created_at: "not", created_by: "not", updated_at: "not", workspace_id: "not" },
  edges: { condition_tag: "text", created_at: "not", created_by: "not", from_step_id: "not", id: "not", label: "text", process_id: "not", revision_id: "not", to_step_id: "not", updated_at: "not", workspace_id: "not" },
  findings: { ai_key: "not", analysis_id: "not", created_at: "not", created_by: "not", decided_at: "not", decided_by: "not", evidence: "text", id: "not", origin: "not", process_id: "not", proposed_via: "not", rating: "not", run_id: "not", source_ids: "not", status: "not", step_id: "not", title: "text", type: "not", updated_at: "not", updated_by: "not", why: "text", workspace_id: "not" },
  first_principles: { created_at: "not", created_by: "not", id: "not", job_done: "text", job_progress: "text", job_situation: "text", job_who: "text", process_id: "not", revision_id: "not", root_cause: "text", updated_at: "not", why_problem: "text", workspace_id: "not" },
  forecast_plans: "unused",
  issue_events: "unused",
  issue_links: { created_at: "not", id: "not", issue_id: "not", process_id: "not", step_id: "not", workspace_id: "not" },
  issue_owners: "unused",
  issue_sources: "unused",
  issues: { client_id: "not", created_at: "not", created_by: "not", detected_key: "not", dismissed_revision_id: "not", evidence: "text", id: "not", owner_person_id: "not", person_id: "not", process_id: "not", resolution: "not", resolution_note: "text", resolved_how: "not", resolved_solution_id: "not", resolved_at: "not", role_id: "not", scenario_id: "not", severity: "not", source: "text", status: "not", step_id: "not", target_goal: "text", target_measure: "text", target_now: "text", title: "text", type: "not", updated_at: "not", workspace_id: "not" },
  lead_sources: { created_at: "not", created_by: "not", id: "not", name: "text", updated_at: "not", workspace_id: "not" },
  lever_settings: "unused",
  market_conditions: { created_at: "not", created_by: "not", id: "not", name: "text", preset: "not", updated_at: "not", workspace_id: "not" },
  market_schedule: { condition_id: "not", created_at: "not", created_by: "not", id: "not", updated_at: "not", workspace_id: "not" },
  memberships: "unused",
  narrations: "unused",
  people: { created_at: "not", created_by: "not", email: "text", end_date: "not", id: "not", name: "text", notes: "text", start_date: "not", updated_at: "not", workspace_id: "not" },
  person_capacity_factors: "unused",
  person_leave: { created_at: "not", created_by: "not", end_date: "not", id: "not", note: "text", person_id: "not", start_date: "not", updated_at: "not", workspace_id: "not" },
  person_roles: { created_at: "not", person_id: "not", role_id: "not", workspace_id: "not" },
  person_skills: { created_at: "not", person_id: "not", step_id: "not", workspace_id: "not" },
  process_revisions: { created_at: "not", created_by: "not", id: "not", process_id: "not", published_at: "not", published_by: "not", status: "not", updated_at: "not", workspace_id: "not" },
  processes: { archived_at: "not", archived_by: "not", created_at: "not", created_by: "not", description: "text", draft_revision_id: "not", entity_name: "text", id: "not", kind: "not", live_revision_id: "not", name: "text", parent_process_id: "not", source: "text", updated_at: "not", workspace_id: "not" },
  reports: "unused",
  robustness_results: "unused",
  roles: { color: "text", created_at: "not", created_by: "not", id: "not", name: "text", updated_at: "not", workspace_id: "not" },
  runs: "unused",
  scenarios: { created_at: "not", created_by: "not", description: "text", id: "not", name: "text", parent_scenario_id: "not", updated_at: "not", workspace_id: "not" },
  seasonality: { created_at: "not", created_by: "not", id: "not", updated_at: "not", workspace_id: "not" },
  service_servicing: { created_at: "not", created_by: "not", id: "not", process_id: "not", service_id: "not", updated_at: "not", workspace_id: "not" },
  services: { created_at: "not", created_by: "not", entry_process_id: "not", id: "not", name: "text", path_tags: "text", pricing_model: "not", updated_at: "not", workspace_id: "not" },
  solution_issues: { auto_note: "text", auto_verdict: "not", created_at: "not", created_by: "not", issue_id: "not", solution_id: "not", updated_at: "not", user_notes: "text", user_verdict: "not", workspace_id: "not" },
  share_links: "unused",
  solutions: { base_revision_id: "not", created_at: "not", created_by: "not", id: "not", name: "text", notes: "text", process_id: "not", updated_at: "not", workspace_id: "not" },
  source_links: "unused",
  sources: "unused",
  steps: { child_process_id: "not", created_at: "not", created_by: "not", entry_step_id: "not", id: "not", kind: "not", name: "text", notes: "text", outcome: "not", parent_step_id: "not", person_id: "not", process_id: "not", replaced_by: "not", revision_id: "not", rework_to_step_id: "not", role_id: "not", tool: "text", updated_at: "not", wait_dist: "not", work_dist: "not", workspace_id: "not" },
  suggestion_proposals: "unused",
  suggestions: "unused",
  workspace_access_emails: "unused",
  workspace_domains: "unused",
  workspace_headlines: "unused",
  user_tours: "unused",
  workspaces: { created_at: "not", created_by: "not", id: "not", name: "text", plan: "text", slug: "not", updated_at: "not" },
};

const FP = {
  statement: { text: "text", kind: "not", source: "text", test: "text", linked_parameter: "not" },
  requirement: { text: "text", owner_person_id: "not", owner_text: "text", why: "text", verdict: "not", step_id: "not" },
  delete: { step_id: "not", breaks_if_removed: "text", agreed_by: "not" },
  improvement: { step_id: "not", stage: "not", text: "text", scenario_id: "not" },
  measure: { id: "not", text: "text", kpi: "not", comparator: "not", horizon: "text" },
} satisfies {
  statement: Record<StrKeys<FpStatement>, Class>;
  requirement: Record<StrKeys<FpRequirement>, Class>;
  delete: Record<StrKeys<FpDeleteCandidate>, Class>;
  improvement: Record<StrKeys<FpImprovement>, Class>;
  measure: Record<StrKeys<FpMeasure>, Class>;
};
// job.who/progress/situation/done and why.problem/chain/root: all free text, whatever the document.
const FP_JOB_WHY_TEXT = ["who", "progress", "situation", "done", "problem", "chain", "root"];

// The other JSON shapes a snapshot carries (jsonb columns, the fields a row type adds to its table, and the snapshot's own
// envelope), classified the same way and exhaustive at the type level: a new string field in one of them stops this file
// compiling until it is classified. A key name is one entry on SHARE_NON_TEXT_KEYS whatever shape it is in, so the tests below
// fail when a key is text in one shape and not text in another (it must then stay off the list and be scrubbed, like `source`).
// Not here: `provenance` (emptied in every snapshot; both checks refuse a non-empty one) and `person_labels` (label -> person id:
// keys are never touched and the values are uuids).
type IssueRowExtra = Exclude<StrKeys<IssueRow>, Cols<"issues">>;
type FindingRowExtra = Exclude<StrKeys<FindingRow>, Cols<"findings">>;
type ProcessListEntry = ProcessShare["processes"][number];
const SHAPES = {
  /** scenarios.patch[], solutions.lever_changes[] (and a play link's levers). */
  patch: { path: "not", op: "not" },
  /** findings.facts[]: a fact, or a quote (`kind` quote), which every snapshot drops. */
  fact: { kind: "not", key: "not", text: "text" },
  /** issues.links[]. */
  issueLink: { process_id: "not", step_id: "not" },
  /** What IssueRow adds to the issues table: owners and cited sources. */
  issueExtra: { owner_ids: "not", source_ids: "not" },
  findingExtra: {},
  /** service_servicing.recurrence (the weekly or monthly form; the other has no string). */
  recurrence: { every: "not" },
  /** workspaces.settings. */
  settings: { currency: "not" },
  /** solutions.steps (its steps and edges are the steps and edges tables' rows). */
  blockBundle: { entry_step_id: "not" },
  /** bundle.viewer, set by the redaction. */
  viewer: { ownPersonId: "uuid" },
  solutionsData: { aiIds: "uuid" },
  /** The snapshot itself, per kind. */
  overview: { kind: "not", workspaceName: "text" },
  process: { kind: "not", workspaceName: "text", hiddenLevers: "not" },
  issue: { kind: "not", workspaceName: "text", issueId: "not" },
  solution: { kind: "not", workspaceName: "text", solutionId: "not", movedOn: "text" },
  /** A process snapshot's `processes[]`. */
  processList: { id: "not", name: "text", parentId: "uuid", kind: "not" },
} satisfies {
  patch: Record<StrKeys<ScenarioPatch>, Class>;
  fact: Record<StrKeys<FindingCitation>, Class>;
  issueLink: Record<StrKeys<IssueLinkRef>, Class>;
  issueExtra: Record<IssueRowExtra, Class>;
  findingExtra: Record<FindingRowExtra, Class>;
  recurrence: Record<StrKeys<Extract<RecurrenceJson, { every: unknown }>>, Class>;
  settings: Record<StrKeys<WorkspaceSettings>, Class>;
  blockBundle: Record<StrKeys<BlockBundle>, Class>;
  viewer: Record<StrKeys<Viewer>, Class>;
  solutionsData: Record<StrKeys<SolutionsData>, Class>;
  overview: Record<StrKeys<OverviewShare>, Class>;
  process: Record<StrKeys<ProcessShare>, Class>;
  issue: Record<StrKeys<IssueShare>, Class>;
  solution: Record<StrKeys<SolutionShare>, Class>;
  processList: Record<StrKeys<ProcessListEntry>, Class>;
};

/** Every classified shape: table columns, the first-principles document and the JSON shapes above, by name. */
const ALL_SHAPES: [string, Record<string, Class>][] = [
  ...Object.entries(TABLES).flatMap(([k, v]) => (v === "unused" ? [] : [[k, v as Record<string, Class>] as [string, Record<string, Class>]])),
  ...Object.entries(FP).map(([k, v]) => [`first_principles.${k}`, v as Record<string, Class>] as [string, Record<string, Class>]),
  ["first_principles.job/why", Object.fromEntries(FP_JOB_WHY_TEXT.map((k) => [k, "text" as Class]))],
  ...Object.entries(SHAPES).map(([k, v]) => [`json.${k}`, v as Record<string, Class>] as [string, Record<string, Class>]),
];

describe("every string column is classified, from the database types", () => {
  const NOT_TEXT = new Set(SHARE_NON_TEXT_KEYS);
  const textKeys = new Set<string>();
  const notKeys = new Set<string>();
  for (const [, shape] of ALL_SHAPES) for (const [k, v] of Object.entries(shape)) if (v !== "uuid") (v === "text" ? textKeys : notKeys).add(k);

  it("a column classified as text is never on the no-text list", () => {
    expect([...textKeys].filter((k) => NOT_TEXT.has(k))).toEqual([]);
  });

  it("a column classified as not text is on the no-text list, unless the same name is text elsewhere (then it is scrubbed)", () => {
    expect([...notKeys].filter((k) => !NOT_TEXT.has(k) && !textKeys.has(k))).toEqual([]);
  });

  it("every table is classified (used or unused), and the used ones are the ones a snapshot loads", () => {
    const used = Object.entries(TABLES).filter(([, v]) => v !== "unused").map(([k]) => k);
    expect(used.length).toBeGreaterThan(20);
    expect(Object.keys(TABLES).length).toBeGreaterThan(50);
  });

  it("a key means one thing in every shape: never text in one and not text in another, unless it stays off the list", () => {
    // A key used both ways must be classified text in every shape and stay off the list, as `source` is (an enum on an issue,
    // text in a first-principles statement: classified text above in both, and scrubbed everywhere). None is left both ways.
    const both = [...textKeys].filter((k) => notKeys.has(k)).sort();
    expect(both).toEqual([]);
    expect(textKeys.has("source") && !NOT_TEXT.has("source")).toBe(true);
  });

  it("a uuid-only field is never text anywhere", () => {
    const uuids = ALL_SHAPES.flatMap(([, s]) => Object.entries(s).filter(([, v]) => v === "uuid").map(([k]) => k));
    expect(uuids.filter((k) => textKeys.has(k))).toEqual([]);
  });
});

describe("every key on the no-text list carries a reason", () => {
  it("one non-empty line each, and the list is exactly the reasons' keys", () => {
    expect(SHARE_NON_TEXT_KEYS).toEqual(Object.keys(SHARE_NON_TEXT_REASONS));
    for (const [k, why] of Object.entries(SHARE_NON_TEXT_REASONS)) {
      expect(why.trim().length, k).toBeGreaterThan(10);
      expect(why, k).not.toMatch(/\n/);
    }
  });

  it("each reason names where the key is; a key in no shape a snapshot carries says so (or that provenance is emptied)", () => {
    const where = new Map<string, string[]>();
    for (const [name, shape] of ALL_SHAPES) for (const [k, v] of Object.entries(shape)) if (v === "not") where.set(k, [...(where.get(k) ?? []), name]);
    const absent = SHARE_NON_TEXT_KEYS.filter((k) => !where.has(k));
    for (const k of absent) expect(SHARE_NON_TEXT_REASONS[k], k).toMatch(/not in a snapshot|provenance is emptied/);
    // And the other way round: a key a snapshot does carry must not claim it isn't there.
    for (const k of SHARE_NON_TEXT_KEYS.filter((x) => where.has(x))) expect(SHARE_NON_TEXT_REASONS[k], `${k} is in ${where.get(k)!.join(", ")}`).not.toMatch(/not in a snapshot/);
  });

  it("the generic keys say which shape they belong to", () => {
    const shapeOf: Record<string, RegExp> = {
      key: /facts\[\]\.key/,
      by: /provenance/,
      at: /provenance/,
      origin: /findings\.origin/,
      status: /issues/,
      kind: /steps/,
      type: /issues\.type/,
      model: /ai_analyses/,
      path: /patch\[\]\.path/,
      op: /patch\[\]\.op/,
    };
    for (const [k, re] of Object.entries(shapeOf)) expect(SHARE_NON_TEXT_REASONS[k], k).toMatch(re);
  });
});
