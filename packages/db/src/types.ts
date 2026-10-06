// Row shapes the app and engine work with. The database shape itself lives in
// `database.types.ts` (generated: `pnpm --filter @transpera-flow/db gen:types`); these
// narrow its check-constrained text and jsonb columns, and the checks at the
// bottom fail the typecheck if they drift from it.

import type { IssueType, ScenarioPatch, StoredSeverity } from "@transpera-flow/engine";
import type { Database, Json } from "./database.types";
import type { Viewer } from "./queries";

export type MembershipRole = "agency_admin" | "owner" | "editor" | "member" | "viewer";
export type StepKind = "task" | "wait" | "decision" | "subprocess" | "group" | "start" | "end";
export type StepOutcome = "won" | "lost" | "done";
export type Distribution = "constant" | "triangular" | "lognormal";
export type PricingModel = "retainer" | "one_off" | "hourly";

/**
 * A step duration's distribution parameters (`work_params`, `wait_params`).
 * Lognormal reads `cv` (spread relative to the mean); triangular reads `min`,
 * `mode` and `max` in hours; constant reads nothing. Missing keys use defaults.
 * A type alias, not an interface, so it stays assignable to the jsonb column.
 */
export type DistParams = { cv?: number | null; min?: number | null; mode?: number | null; max?: number | null };

export interface WorkspaceSettings {
  hours_per_week: number;
  horizon_weeks: number;
  currency: string;
  /** Arrivals a week while the workspace has no lead sources; the other three are interim until services and clients land. */
  leads_per_week: number;
  active_clients: number;
  churn_monthly: number;
  retainer: number;
  /** Minimum share of a person's week left for pipeline work (default 0.08). */
  availability_floor?: number;
  /**
   * Overtime someone may work when their client work exceeds their week, as a
   * share of their capacity (default 0: none; docs/PRD.md §6.3.4, decision D7).
   */
  overtime_cap?: number;
  /**
   * How servicing moves client health (docs/PRD.md §6.3.5; issue #19):
   * health added for a task done on time, taken off for a late one and for a
   * missed one, and the health of a client with none entered. Left out: the
   * estimated defaults (2, 5, 12, 80).
   */
  health_recover?: number;
  health_late_penalty?: number;
  health_missed_penalty?: number;
  health_initial?: number;
  /**
   * The range of company client health that is normal for the business, 0–100
   * (for example 70 to 80 for a small agency). The People page shows the
   * company's simulated client health against it. Left out: no benchmark.
   */
  client_health_benchmark_low?: number;
  client_health_benchmark_high?: number;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  settings: WorkspaceSettings;
  /** Provenance of the settings, keyed `settings.<key>` (issue #25); loaded only where shown. */
  provenance?: ProvenanceMap;
}

export interface RoleRow {
  id: string;
  workspace_id: string;
  name: string;
  color: string | null;
  default_cost_rate: number;
  headcount: number;
  ongoing_hours_per_client_week: number;
  /** Inactive roles are hidden from pickers; what already names one keeps it, and it still simulates. */
  active: boolean;
}

export interface PersonRow {
  id: string;
  workspace_id: string;
  name: string;
  fte: number;
  capacity_hours_week: number | null;
  cost_rate: number | null;
  active: boolean;
  start_date: string | null;
  end_date: string | null;
  /** Provenance of fte, capacity, cost rate and dates (issue #25); loaded only where shown. */
  provenance?: ProvenanceMap;
}

export interface PersonRoleRow {
  person_id: string;
  role_id: string;
  workspace_id: string;
}

export interface PersonSkillRow {
  person_id: string;
  step_id: string;
  workspace_id: string;
}

export interface PersonLeaveRow {
  id: string;
  person_id: string;
  workspace_id: string;
  /** ISO date, inclusive. */
  start_date: string;
  /** ISO date, inclusive. */
  end_date: string;
}

export interface ProcessRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: "pipeline" | "servicing";
  entity_name: string;
  description: string | null;
  live_revision_id: string | null;
  /**
   * The process this one sits inside (a child process, held by one of the
   * parent's steps), or null for a top-level process: the company map's steps
   * are the top-level processes (issue #102).
   */
  parent_process_id: string | null;
  /**
   * True for the workspace's company map: a stored process whose steps are holders of the top-level processes (B11,
   * #163). It is never simulated and is left out of every list of processes. Absent (false) on fixtures.
   */
  is_company?: boolean;
  /**
   * When the process was archived (B19, #182): off the map, the lists and the simulation, read only, its history kept. Null or
   * absent for a process in use.
   */
  archived_at?: string | null;
}

export interface ProcessRevisionRow {
  id: string;
  workspace_id: string;
  process_id: string;
  number: number;
  status: "draft" | "published" | "superseded";
}

export interface StepRow {
  id: string;
  revision_id: string;
  workspace_id: string;
  process_id: string;
  name: string;
  kind: StepKind;
  outcome: StepOutcome | null;
  role_id: string | null;
  person_id: string | null;
  work_hours: number;
  work_dist: Distribution;
  work_params: DistParams;
  wait_hours: number;
  wait_dist: Distribution;
  wait_params: DistParams;
  rework_rate: number;
  /** Step a rework goes back to; null means the same step. Not simulated yet. */
  rework_to_step_id: string | null;
  tool: string | null;
  notes: string | null;
  /** Target hours for one visit to the step (queue + hands-on + wait); visits over it are SLA breaches. */
  sla_hours: number | null;
  /** How long an item may queue for a person before it counts as waiting too long, in hours; null: the workspace default for the step's kind. */
  expected_wait_hours: number | null;
  /** The share of items that go cold for each working day they wait here (0 to 1); null: none assumed. For the cost of waiting. */
  lost_per_day_waiting: number | null;
  /** The share of the items leaving the step that may be lost here and still be fine (0 to 1); null: the step isn't rated for work lost. */
  dropoff_benchmark: number | null;
  /** Set on the process's start step: how long an item should take end to end, in working hours; null: the process isn't rated. */
  target_cycle_hours: number | null;
  /** Items sitting at this step now; null when not entered (docs/PRD.md §6.3.1). */
  current_wip: number | null;
  x: number;
  y: number;
  /**
   * The group this step sits in (a step of kind `group` in the same revision),
   * or null at the top level of its process. `x`/`y` of a step in a group are
   * relative to the group's box. Any depth, no loops (issue #102).
   */
  parent_step_id: string | null;
  /** For a group: the step of it where entities enter (one of its own steps). */
  entry_step_id: string | null;
  /**
   * For a `subprocess` step: the child process it holds (its `parent_process_id`
   * is this step's process). The engine simulates the child's live steps in its place.
   */
  child_process_id: string | null;
  /**
   * The step's values are estimates nobody has confirmed yet (e.g. filled in
   * by the MCP server). Publishing a draft with any is refused unless they are
   * accepted as estimates (docs/PRD.md §7.1b).
   */
  assumption: boolean;
  /**
   * Sources disagree on one of the step's values and nobody has settled it
   * yet (docs/PRD.md §4.1 Sources and evidence, D17). Kept in step with the
   * per-column `provenance.<column>.conflict` entries (see evidence.ts).
   */
  conflict: boolean;
  /** Where each value came from, per column (`{work_hours: {source, at, by, evidence, conflict}}`). */
  provenance: ProvenanceMap;
  /**
   * Steps that took over this one's work when it was split or replaced in the
   * editor (docs/PRD.md §4.1 "Stable step IDs"). A step with any is retired:
   * its row stays in the revision so saved scenarios aimed at it can be
   * re-pointed (issue #16), but it is never drawn or simulated; loaders put
   * it in `ProcessBundle.retired`, not `steps`. Absent or empty on live steps.
   */
  replaced_by?: string[];
}

export interface EdgeRow {
  id: string;
  revision_id: string;
  workspace_id: string;
  process_id: string;
  from_step_id: string;
  to_step_id: string;
  probability: number;
  condition_tag: string | null;
  label: string | null;
}

/**
 * Something the business sells (docs/PRD.md §5). Each arrival at a process is
 * tagged with one of the active services entering it, drawn from the mix, and
 * is priced and routed by it (§6.4 revenue rules, decision D8).
 */
export interface ServiceRow {
  id: string;
  workspace_id: string;
  name: string;
  pricing_model: PricingModel;
  /** Monthly fee (retainer), whole fee (one-off) or hourly rate. */
  price: number;
  /** Gross margin as a share of price (0–1). */
  margin: number;
  /** Expected tenure of a retainer client, in months. */
  tenure_months: number;
  /** Base monthly churn (0–1): at full health, the churn of a client on this service. */
  churn_monthly_base: number;
  /**
   * How much poor health raises churn (docs/PRD.md §6.3.5): monthly churn =
   * base × (1 + sensitivity × (100 − health) / 100). Default 3, an estimate.
   */
  churn_health_sensitivity: number;
  /** Relative share of arrivals. */
  mix_share: number;
  /** Process its arrivals enter; null means the workspace's pipeline (whichever process is simulated). */
  entry_process_id: string | null;
  /** Condition tags its entities follow (`edges.condition_tag`). */
  path_tags: string[];
  /**
   * Hours a month each client on this service needs from each role (role id →
   * hours), while no servicing process is mapped (docs/PRD.md §6.3.4). Empty:
   * the roles' `ongoing_hours_per_client_week` apply.
   */
  fallback_ongoing_load: FallbackLoad;
  /** Inactive services are left out of simulations. */
  active: boolean;
  /** Provenance of the pricing and churn values (issue #25); loaded only where shown. */
  provenance?: ProvenanceMap;
}

/** Role id → hours a month per client. A type alias, so it stays assignable to the jsonb column. */
export type FallbackLoad = { [roleId: string]: number };

/** Where a parameter's value came from (docs/PRD.md §3 Parameter provenance). */
export type ProvenanceSource = "estimated" | "entered" | "measured";

/**
 * One value's provenance (the §5 `provenance jsonb` shape). A type alias, not
 * an interface, so it stays assignable to the jsonb column.
 */
export type Provenance = {
  source: ProvenanceSource;
  /** When it was set (ISO timestamp). */
  at?: string;
  /** User who set it. */
  by?: string;
  /** Dataset a measured value came from. */
  dataset_id?: string;
  /** Why the value is what it is (e.g. Claude's reasoning for an assumption). */
  note?: string;
  /** Filled in without a source (a default or an inference); listed for confirmation until someone confirms it. */
  assumption?: boolean;
  /** What people said about the value (docs/PRD.md §7.2). */
  evidence?: EvidenceCitation[];
  /** Sources disagree on the value: what each said, and whether someone has settled it. */
  conflict?: ProvenanceConflict;
  /** The accepted suggestion the value came from (issue #25). */
  suggestion_id?: string;
  /**
   * On a step's `branch_odds` entry (issue #167): its branches took the share the others leave because the file gave no odds.
   * Goes away when anyone writes one of the branches' probabilities (a trigger), so "Missing for simulation" can list the step.
   */
  defaulted?: boolean;
  /** On `branch_odds`: each branch's probability (by the id of the step it leads to) as it was when defaulted. Changing any of them clears the gap at once. */
  was?: { [toStepId: string]: number };
};

/**
 * One citation of a source for a value (docs/PRD.md §5 `provenance.evidence`):
 * who said it, their words and where in the recording. `value` is the number
 * they stated, in the column's units (hours, a 0–1 share, items), when they
 * stated one; citations that state different values make a conflict.
 */
export type EvidenceCitation = {
  source_id: string;
  speaker?: string | null;
  quote: string;
  /** Where in the source: a time in the recording ("00:12:40"), a page, or a date. */
  timestamp?: string | null;
  value?: number | null;
};

/** One of the disagreeing values (docs/PRD.md §5 `provenance.conflict.values`). */
export type ConflictValue = { value: number; source_id: string | null; speaker: string | null };

/**
 * A disagreement between sources. The value becomes a triangular range over
 * `values` until someone settles it; `resolved` records who did and how.
 */
export type ProvenanceConflict = {
  values: ConflictValue[];
  resolved?: { at: string; by?: string; choice: "range" | "value" };
};

/**
 * Provenance per value column, as stored in a row's `provenance` jsonb
 * (e.g. `{volume_week: {...}, conversion_to_qualified: {...}}`). The
 * database stamps `entered` when a person changes a value; a value with no
 * entry is an estimate.
 */
export type ProvenanceMap = { [column: string]: Provenance | undefined };

/**
 * A client on the roster (docs/PRD.md §5 `clients`, decision D13). Real
 * clients seed the simulation; per-person client counts come from
 * `client_assignments`.
 */
export interface ClientRow {
  id: string;
  workspace_id: string;
  name: string;
  /** ISO date they became a client; null if not known. */
  start_date: string | null;
  /** Monthly recurring revenue. */
  mrr: number;
  /** 0–100; null: not entered (simulated from the estimated 80). */
  health: number | null;
  /** Provenance of `mrr` and `health`. */
  provenance: ProvenanceMap;
  notes: string | null;
  /** Inactive clients (they left) are kept on record but not simulated. */
  active: boolean;
}

/** A service a client takes. */
export interface ClientServiceRow {
  client_id: string;
  service_id: string;
  workspace_id: string;
  /** When they started on it; null: with the client. */
  start_date: string | null;
}

/** The person looking after a client for a role. No row: the role's people share it. */
export interface ClientAssignmentRow {
  client_id: string;
  role_id: string;
  person_id: string;
  workspace_id: string;
}

/**
 * The clients of one service, counted instead of named (docs/PRD.md decision
 * D27; issue #120). One row per service. The engine simulates that many
 * unnamed clients from these numbers.
 */
export interface ClientGroupRow {
  id: string;
  workspace_id: string;
  service_id: string;
  /** How many clients the service has today. */
  client_count: number;
  /** What one client pays a month. */
  fee: number;
  /** Share of clients that leave each month when all is going well (0–1). */
  churn_monthly: number;
  /** How long a client usually stays, in months. */
  stay_months: number;
  /** 0–100. */
  starting_health: number;
  /** Provenance of the five numbers. */
  provenance: ProvenanceMap;
}

/**
 * A process revision's first principles (issue #119, A54): the job and root cause as text, the lists the rule checks
 * read as jsonb arrays. `FirstPrinciples` (engine) is the app-side shape of the whole, read with
 * `firstPrinciplesFromRow`.
 */
export interface FirstPrinciplesRow {
  id: string;
  workspace_id: string;
  process_id: string;
  revision_id: string;
  job_who: string;
  job_progress: string;
  job_situation: string;
  job_done: string;
  statements: Json;
  requirements: Json;
  deletes: Json;
  improvements: Json;
  why_problem: string;
  why_chain: Json;
  root_cause: string;
  measures: Json;
  updated_at: string;
}

/** The five switches on Settings -> AI analysis (issue #111, A46). No row means the defaults. */
export interface AiSettingsRow {
  workspace_id: string;
  review_on_publish: boolean;
  review_on_market: boolean;
  suggest_issues: boolean;
  suggest_solutions: boolean;
  read_sources: boolean;
  /** A market change whose review hasn't started (debounces the market trigger); not a switch. */
  market_pending_at: string | null;
  updated_at: string;
}

/** A model run that was started (A46): the log the daily cap and the cooldown count. Written only by `reserve_ai_run`. */
export interface AiRunRow {
  id: string;
  workspace_id: string;
  process_id: string;
  trigger: "publish" | "market" | "manual";
  user_id: string | null;
  user_name: string | null;
  started_at: string;
}

export type AiAnalysisStatus = "ok" | "unavailable" | "failed";
export type AiAnalysisTrigger = "publish" | "market" | "manual";

/**
 * What AI wrote about one process version (issue #111, A46): the read, the insights and the first-principles review,
 * each as jsonb whose app-side shape lives in apps/web/src/lib/ai/types.ts.
 */
export interface AiAnalysisRow {
  id: string;
  workspace_id: string;
  process_id: string;
  revision_id: string;
  status: AiAnalysisStatus;
  reason: string | null;
  trigger: AiAnalysisTrigger;
  summary: Json;
  insights: Json;
  review: Json;
  checked: number;
  dropped: number;
  input_hash: string;
  model: string | null;
  /** A hash of the model it read (engine model, first principles, prompt version): a different hash now means it is out of date (B17). Null on rows from before. */
  model_hash: string | null;
  usage: Json;
  /** The reserved run that wrote it, and so who ran it. */
  run_id: string;
  /** The labels its text uses ("Team member A") and the person each stands for: `{ label: person id }` (B1 2b). Names go back at render. */
  person_labels: Json;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type FindingOrigin = "ai" | "manual";
export type FindingStatus = "proposed" | "accepted" | "dismissed" | "superseded";
export type FindingRating = "risk" | "bad" | "good" | "great";
export const FINDING_TYPES = ["bottleneck", "spof", "manual", "delay", "failure", "idea", "capacity", "sla", "churn_risk"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/** A fact or quote a finding rests on, as it read when cited. */
export interface FindingCitation {
  kind: "fact" | "quote";
  /** The fact's key (`<detector>:<subject>:<id>`), or the step a quote is cited on. */
  key: string;
  text: string;
}

/**
 * A finding (issue #175, B17; decision D40): what AI or a person concludes from the engine's facts. AI findings arrive
 * proposed and a person accepts, edits or dismisses them; findings by hand start accepted. Only accepted ones show on the
 * pages, and one can be acknowledged as an issue (`detected_key = 'finding:<origin>:<id>'`).
 */
export interface FindingRow {
  id: string;
  workspace_id: string;
  /** Null: across the company. */
  process_id: string | null;
  step_id: string | null;
  origin: FindingOrigin;
  status: FindingStatus;
  rating: FindingRating;
  type: FindingType;
  title: string;
  evidence: string;
  why: string;
  facts: Json;
  /** The labels its title, evidence, why and facts use ("Team member A") and the person each stands for (B1 2b). `{}` for a finding by hand. */
  person_labels: Json;
  source_ids: string[];
  ai_key: string | null;
  analysis_id: string | null;
  /** The run that last proposed it (analyses are kept one per version; each run has its own id). */
  run_id: string | null;
  /** 'connector' when Claude proposed it over the MCP connector (B20); null otherwise. Set by the database. */
  proposed_via: "connector" | null;
  /** An AI finding a person has changed (set by the database only): its words are no longer only AI's. */
  edited: boolean;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

export type SourceKind = "transcript" | "notes" | "sop" | "spreadsheet" | "data" | "screenshot" | "other";

/**
 * A transcript, note set or screenshot from the audit (docs/PRD.md §3 Source,
 * §5 `sources`). Parameters cite it by id in `provenance.<column>.evidence`.
 */
export interface SourceRow {
  id: string;
  workspace_id: string;
  kind: SourceKind;
  title: string;
  speakers: string[];
  /** ISO date the conversation or notes are from. */
  recorded_at: string | null;
  /** The transcript or notes text. */
  body: string | null;
  /** Link to the file (a screenshot, the recording), if it lives elsewhere. */
  file_url: string | null;
  created_at: string;
  updated_at: string;
}

/** A source as the library lists it (migration 20261130500000, `search_sources`): everything but the full text. */
export type SourceListRow = Omit<SourceRow, "body"> & {
  /** The first words of the text, or the words around the first match of a search. Empty when there is no text. */
  excerpt: string;
  /** Whether there is any text to read when the source is opened. */
  has_body: boolean;
};

/** What a source can be linked to (issue #118, A53). */
export type SourceLinkKind = "process" | "step" | "insight" | "issue" | "solution";

/**
 * One thing a source is evidence for (`source_links`): the column of its kind is set and the others are null. A step is
 * named by its stable id and the process it is in; an insight by its detection key.
 */
export interface SourceLinkRow {
  id: string;
  workspace_id: string;
  source_id: string;
  kind: SourceLinkKind;
  process_id: string | null;
  step_id: string | null;
  insight_key: string | null;
  issue_id: string | null;
  solution_id: string | null;
  created_at: string;
  created_by: string | null;
}

/** Where qualified leads come from (docs/PRD.md §5 `lead_sources`). */
export interface LeadSourceRow {
  id: string;
  workspace_id: string;
  name: string;
  /** Leads a week. */
  volume_week: number;
  /** Share that become qualified leads (0–1). */
  conversion_to_qualified: number;
  provenance: ProvenanceMap;
}

/** One month of the seasonality curve. A month with no row has a multiplier of 1. */
export interface SeasonalityRow {
  id: string;
  workspace_id: string;
  /** 1 = January. */
  month: number;
  multiplier: number;
  provenance: ProvenanceMap;
}

/** The workspace's growth assumption; no row means no growth. */
export interface DemandSettingsRow {
  workspace_id: string;
  /** Compound change in the arrival rate per month (0.02 is +2%). */
  growth_monthly: number;
  provenance: ProvenanceMap;
}

/** A market condition (A57): seven factors as whole percents of today (100 = the same). The four presets are read-only. */
export interface MarketConditionRow {
  id: string;
  workspace_id: string;
  name: string;
  /** boom, stable, soft or downturn for a preset; null for your own. */
  preset: MarketPreset | null;
  /** Enquiries. */
  leads: number;
  /** Enquiries that sign. */
  conv: number;
  /** Time to decide. */
  cycle: number;
  /** Prices you can charge. */
  price: number;
  /** Clients leaving. */
  churn: number;
  /** Time to hire. */
  hire: number;
  /** Late payments. */
  pay: number;
}

export type MarketPreset = "boom" | "stable" | "soft" | "downturn";

/** The ten built-in churn drivers (docs/PRD.md decision D28; A56). The engine's `BUILTIN_CHURN_DRIVER_IDS`. */
export type ChurnDriverKey = "late" | "resp" | "onb" | "rework" | "load" | "handoff" | "results" | "tenure" | "price" | "market";

/**
 * A churn driver you have set (A56): a built-in's weight and switch, or one of
 * your own with a name, description and example. A built-in with no row is at
 * its default. One row per built-in per workspace.
 */
export interface ChurnDriverRow {
  id: string;
  workspace_id: string;
  /** The built-in it sets; null for your own. */
  driver: ChurnDriverKey | null;
  /** Your own drivers only. */
  name: string | null;
  description: string | null;
  example: string | null;
  /** 0 to 3: 1 is normal, 0 ignores the cause. */
  weight: number;
  enabled: boolean;
  /** What you enter, where the driver takes a number (the engine's `ChurnDriverSpec.valueLabel`). */
  value: number | null;
  /** Price changes: the month of the run the rise takes effect. */
  month: number | null;
  /** Provenance of weight, enabled, value and month. */
  provenance: ProvenanceMap;
}

/** One change on the 24-month schedule: a condition from month `from_month` to `to_month` (1-based, inclusive). */
export interface MarketScheduleRow {
  id: string;
  workspace_id: string;
  from_month: number;
  to_month: number;
  condition_id: string;
}

/**
 * How often a client generates a servicing task (docs/PRD.md §5
 * `service_servicing.recurrence`): `times` tasks spread evenly over every
 * week or month, or ad-hoc requests at random, `poisson_per_month` a month on
 * average. A type alias, so it stays assignable to the jsonb column.
 */
export type RecurrenceJson = { every: "week" | "month"; times: number } | { poisson_per_month: number };

/**
 * A servicing process a service's clients run, and how often (docs/PRD.md
 * §5 `service_servicing`, §6.3.5; issue #19).
 */
export interface ServiceServicingRow {
  id: string;
  workspace_id: string;
  service_id: string;
  /** A process of kind `servicing`. */
  process_id: string;
  recurrence: RecurrenceJson;
  /** On time within this many working hours of the task starting; missed beyond twice it. */
  sla_hours: number;
  /** Provenance of `recurrence` and `sla_hours`. */
  provenance: ProvenanceMap;
}

/** One process at one revision: what a run needs of a process other than the one on screen. */
export interface ProcessPart {
  process: ProcessRow;
  revision: ProcessRevisionRow;
  steps: StepRow[];
  edges: EdgeRow[];
}

/** Everything needed to render and simulate one process revision. */
export interface ProcessBundle {
  /** Who loaded it (B1 2/3). Absent means "sees everyone" (demo fixtures, tests, the golden models). */
  viewer?: Viewer;
  /** Pay is hidden even though the viewer may see everyone (a share link, B3). */
  payHidden?: true;
  workspace: WorkspaceRow;
  roles: RoleRow[];
  process: ProcessRow;
  revision: ProcessRevisionRow;
  steps: StepRow[];
  edges: EdgeRow[];
  /**
   * Steps of this revision that were split or replaced (they have
   * `replaced_by`). Kept apart from `steps` so nothing draws or simulates
   * them; read to re-point scenarios that still target them (issue #16).
   */
  retired?: StepRow[];
  /** Named people. When empty, roles' head-counts are used instead. */
  people: PersonRow[];
  personRoles: PersonRoleRow[];
  personSkills: PersonSkillRow[];
  personLeave: PersonLeaveRow[];
  /** The workspace's services. When none apply, every win is priced at the workspace's interim `retainer`. */
  services: ServiceRow[];
  /**
   * The workspace's demand model (issue #13). With no lead sources, the
   * interim `settings.leads_per_week` is the arrival rate; with no
   * seasonality rows or demand settings, it is constant.
   */
  leadSources?: LeadSourceRow[];
  seasonality?: SeasonalityRow[];
  demand?: DemandSettingsRow | null;
  /**
   * Market conditions (A57) and the 24-month schedule. With no schedule (or
   * every month Stable) the model is simulated exactly as before.
   */
  marketConditions?: MarketConditionRow[];
  marketSchedule?: MarketScheduleRow[];
  /**
   * Churn drivers you have set (A56). With none, drivers are at their
   * defaults, which is how clients churned before drivers existed.
   */
  churnDrivers?: ChurnDriverRow[];
  /**
   * The client roster (issue #18). With any clients, ongoing load is per
   * client and assigned person; with none (or omitted), the interim
   * `settings.active_clients` × the roles' hours per client, as before.
   */
  clients?: ClientRow[];
  clientServices?: ClientServiceRow[];
  clientAssignments?: ClientAssignmentRow[];
  /**
   * Clients counted per service (issue #120). With any groups the engine
   * simulates unnamed clients from them and ignores the named roster above
   * (which stays stored, hidden); with none, the roster applies as before.
   */
  clientGroups?: ClientGroupRow[];
  /**
   * Client servicing (issue #19): which servicing processes each service's
   * clients run, and the workspace's other processes at their live
   * revisions, which a run of this one needs: its servicing processes, and,
   * when this bundle is itself a servicing process, the pipeline it runs
   * beside. Omitted or empty: no servicing, as before it existed.
   */
  servicingLinks?: ServiceServicingRow[];
  otherProcesses?: ProcessPart[];
}

/**
 * A saved scenario: patches applied in order on top of the baseline model
 * (docs/PRD.md §5; the grammar is in packages/engine/src/scenario.ts).
 */
export interface ScenarioRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  patch: ScenarioPatch[];
  parent_scenario_id: string | null;
}

/** By hand (built or saved by a person) or made by the AI ideas (A52). */
export type BlockType = "manual" | "ai";

/** A step of a block: a process's step without the revision, workspace and process it sits in (a block belongs to none). */
export type BlockStep = Omit<StepRow, "revision_id" | "workspace_id" | "process_id">;
/** A connection between two steps of a block. */
export type BlockEdge = Omit<EdgeRow, "revision_id" | "workspace_id" | "process_id">;

/**
 * The steps, connections and groups of a block (`blocks.steps`). Ids are local to the bundle: inserting it into a process
 * gives everything fresh ids. Groups are steps of kind `group` with `parent_step_id` set, as in a process; steps with no
 * parent are the block's top level.
 */
export interface BlockBundle {
  steps: BlockStep[];
  edges: BlockEdge[];
  /** The top-level step the block is entered at; null when it has none to choose. */
  entry_step_id: string | null;
}

/** A saved bundle of steps that can be reused in any process or solution (A51). */
export interface BlockRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  type: BlockType;
  steps: BlockBundle;
  created_at: string;
  updated_at: string;
}

/** How a solution did against an issue's target, or what the user decided. */
export type SolutionVerdict = "pass" | "fail";

/** A separate copy of a process with changed steps, plus optional lever changes (A49, D25). Never a draft: drafts stay single (D18). */
export interface SolutionRow {
  id: string;
  workspace_id: string;
  /** The process it changes. */
  process_id: string;
  /** The revision of that process the copy was made from. */
  base_revision_id: string;
  name: string;
  notes: string;
  /** The whole map as the solution has it (the same shape as a block's bundle). */
  steps: BlockBundle;
  /** Stable ids of the steps it added or changed against the base revision. */
  changed_step_ids: string[];
  /** Lever changes, as scenario patches. */
  lever_changes: ScenarioPatch[];
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/**
 * One marker of a forecast plan (B7, #36). Dates are absolute ISO dates, never month offsets. The ids are checked at write
 * time but are not foreign keys: a role, person or solution deleted later leaves its marker "needs attention" in the app.
 */
export type ForecastPlanMarker =
  /** A new person in a role from `date` (the 1st of a month). `fte` 0.1-2. `name` optional; the app shows "New <role>". */
  | { id: string; kind: "hire"; date: string; role_id: string; fte: number; name?: string }
  /** An existing person away for `weeks` whole weeks from `date` (a Monday). */
  | { id: string; kind: "leave"; date: string; person_id: string; weeks: number }
  /** A saved solution live from `date` (the 1st of a month). */
  | { id: string; kind: "solution"; date: string; solution_id: string };

/** A named set of forecast markers: hires, leave and solutions going live. It never changes the live model. */
export interface ForecastPlanRow {
  id: string;
  workspace_id: string;
  name: string;
  markers: ForecastPlanMarker[];
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** A workspace's solutions and which issues each solves, as loaded with a page (the demo keeps its own in memory). */
export interface SolutionsData {
  solutions: SolutionRow[];
  links: SolutionIssueRow[];
  /** Ids of solutions that were built from an AI idea (a built proposal names them). Left out when that isn't known: they read "By hand". */
  aiIds?: string[];
}

/** One issue a solution solves: the automatic verdict against the issue's target, and the user's own. */
export interface SolutionIssueRow {
  solution_id: string;
  issue_id: string;
  workspace_id: string;
  /** Pass or fail from the simulation; null when the target couldn't be checked by it. */
  auto_verdict: SolutionVerdict | null;
  /** The share of simulated runs that meet the target, 0 to 100. */
  holds_pct: number | null;
  /** What it was checked against, in words. */
  auto_note: string;
  user_verdict: SolutionVerdict | null;
  user_notes: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/**
 * Open, Testing solutions, Resolved, Won't fix, as the app shows them; the database holds them as the older
 * `open`, `in_progress`, `done` plus a `resolution` (see issue-status.ts). And `dismissed`, which is not an issue a person sees: it is what an
 * insight someone dismissed is stored as, so it stays gone. The register, the map and the counts leave it out
 * (`isVisibleIssue`).
 */
export type IssueStatus = "open" | "testing" | "resolved" | "wont_fix" | "dismissed";
/** The four statuses a person can give an issue. */
export const ISSUE_STATUSES = ["open", "testing", "resolved", "wont_fix"] as const satisfies readonly IssueStatus[];
export type VisibleIssueStatus = (typeof ISSUE_STATUSES)[number];
/**
 * A dismissed insight stays dismissed until its process's next published version. True while the process's live
 * revision is the one it was dismissed against. A different live revision means it has expired, and the analysis may
 * list the insight again. A dismissal with no revision on record was made before the process had any version (or
 * migrated without one that could be worked out), so it ends on the first publish.
 */
export function isDismissalCurrent(i: { status: IssueStatus; dismissed_revision_id: string | null }, liveRevisionId: string | null | undefined): boolean {
  if (i.status !== "dismissed") return false;
  // Nothing to compare with (the page doesn't know the process's versions, or it has never been published): it holds.
  if (!liveRevisionId) return true;
  // Dismissed before the process had any version: the first publish ends it.
  if (!i.dismissed_revision_id) return false;
  return i.dismissed_revision_id === liveRevisionId;
}

/** True unless the row is a dismissed insight. */
export const isVisibleIssue = (i: { status: IssueStatus }): boolean => i.status !== "dismissed";
/** Still to be dealt with: open, or having a solution tested. */
export const isActiveStatus = (s: IssueStatus): boolean => s === "open" || s === "testing";

/** One thing an issue touches: a step (by stable id) or, with no step, the whole process. */
export interface IssueLinkRef {
  process_id: string | null;
  step_id: string | null;
}

/** How a resolved issue was resolved: a solution fixed it, the process was changed directly, or it is no longer a problem. */
export type ResolveHow = "solution" | "process_change" | "not_a_problem";
export const RESOLVE_HOWS = ["solution", "process_change", "not_a_problem"] as const satisfies readonly ResolveHow[];

export type IssueEventKind = "created" | "edited" | "solution_tested" | "resolved" | "reopened";
/** Logged by hand, detected by a stored run (reserved), or promoted from a detection. */
export type IssueSource = "manual" | "detected" | "promoted";

/**
 * A tracked issue in the register (docs/PRD.md §5 `issues`). Detected issues
 * aren't stored: they come from each run (engine `detectIssues`); promoting
 * one stores it with its `detected_key`.
 */
export interface IssueRow {
  id: string;
  workspace_id: string;
  process_id: string | null;
  /** A step's stable id (no foreign key: steps are keyed by revision). */
  step_id: string | null;
  role_id: string | null;
  person_id: string | null;
  /** The client it is about (issue #18). */
  client_id: string | null;
  type: IssueType;
  /** The stored value of the issue's rating (great = info, good = warning, bad = serious, risk = critical; see `ratingOfStored`). */
  severity: StoredSeverity;
  title: string;
  evidence: string | null;
  /** Numbers behind the finding, e.g. a promoted detection's metrics. */
  evidence_metrics: Record<string, number>;
  owner_person_id: string | null;
  status: IssueStatus;
  /** The saved scenario "Run the fix" applies. */
  scenario_id: string | null;
  source: IssueSource;
  detected_key: string | null;
  /** Set by the database when the status becomes resolved, won't fix or dismissed. */
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  /** Stable per workspace, never reused: "Issue #12". Assigned by the database. Null for a dismissed insight, which is not an issue. */
  number: number | null;
  /** For a dismissed insight: the live revision of its process it was dismissed against. See `isDismissalCurrent`. */
  dismissed_revision_id: string | null;
  /** How it was resolved, while it is resolved (cleared on reopen; the history keeps it). Null for an issue resolved before this was recorded. */
  resolved_how: ResolveHow | null;
  /** The solution that fixed it, when `resolved_how` is "solution" and one was picked (A50). Cleared on reopen; the history keeps its name. */
  resolved_solution_id: string | null;
  /** The note written when it was resolved. */
  resolution_note: string | null;
  /** What is measured ("Wait at Check fit"), its value now ("1.4 d") and the goal ("under 4 hours"). */
  target_measure: string | null;
  target_now: string | null;
  target_goal: string | null;
  /** What it touches: steps, or (a link with no step) a whole process. `process_id` and `step_id` above are the first. */
  links: IssueLinkRef[];
  /** People who own it; `owner_person_id` above is the first. */
  owner_ids: string[];
  /** Sources linked to it. */
  source_ids: string[];
}

/** One entry of an issue's history. Written by the database; nothing writes it through the API. */
export interface IssueEventRow {
  id: string;
  issue_id: string;
  workspace_id: string;
  /** The order entries were written in. */
  seq: number;
  kind: IssueEventKind;
  at: string;
  actor: string | null;
  detail: Record<string, unknown>;
  tx: number | null;
}

/** The company-model tables a suggestion can change (docs/PRD.md §7.1c). */
export type SuggestionTarget = "workspaces" | "services" | "people" | "clients" | "lead_sources" | "seasonality" | "demand_settings" | "roles";
export type SuggestionStatus = "pending" | "accepted" | "rejected";
export type SuggestionValue = string | number | boolean | null;

/**
 * What a suggestion changes (issue #25). `set` holds column values (for
 * `workspaces`, settings keys). People take `roles` (the full set, by id) and
 * `leave` (periods to add); clients take `services` (the full set, by id) and
 * `assignments` (role id → person id, or null to clear). A type alias, so it
 * stays assignable to the jsonb column.
 */
export type SuggestionPatch = {
  set: { [column: string]: SuggestionValue };
  roles?: string[];
  services?: string[];
  assignments?: { [roleId: string]: string | null };
  leave?: { start_date: string; end_date: string; note?: string | null }[];
};

/** What accepting a suggestion changed: the row, and its values before and after. */
export type SuggestionApplied = {
  target_id: string;
  /** Null when the suggestion created the row. */
  before: { [field: string]: unknown } | null;
  after: { [field: string]: unknown };
};

/**
 * A proposed change to the company model from the MCP server, awaiting a
 * person's accept or reject (docs/PRD.md §3 Suggestion, §5 `suggestions`).
 */
export interface SuggestionRow {
  id: string;
  workspace_id: string;
  target_table: SuggestionTarget;
  /** The row it changes; null: a new row (workspaces and demand_settings: the workspace's own). */
  target_id: string | null;
  patch: SuggestionPatch;
  evidence: EvidenceCitation[];
  /** The suggester's reasoning. */
  note: string | null;
  status: SuggestionStatus;
  created_via: "mcp" | "upload";
  /** The file or link an upload came from (shown as "Upload (name)"). */
  import_source: string | null;
  applied: SuggestionApplied | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  created_by: string | null;
}

/** What is proposed besides company-model changes (A52, docs/PRD.md §7.1c): an issue, or an idea for a solution. */
export type ProposalKind = "issue" | "solution_idea";
/** An issue is accepted or rejected; a solution idea is dismissed (or, in slice 2, built). */
export type ProposalStatus = "pending" | "accepted" | "rejected" | "dismissed" | "built";

/** A proposed issue's payload: what it would be logged with. A type alias, so it stays assignable to jsonb. */
export type IssueProposalPayload = {
  severity?: "critical" | "serious" | "warning" | "info";
  type?: IssueType;
  /** What it touches: a whole process (step_id null) or steps. */
  links?: IssueLinkRef[];
  target_measure?: string;
  target_now?: string;
  target_goal?: string;
};

/** One step an idea would place. `block_id` names the library block it comes from; `ai` marks an AI block. */
export type ProposedStep = { key: string; name: string; kind?: string; role?: string; block_id?: string | null; ai?: boolean };

/** A solution idea's payload: the steps it would place and the ones they replace. Its block map is slice 2. */
export type SolutionIdeaPayload = {
  steps: ProposedStep[];
  edges?: { from: string; to: string }[];
  replaces_step_ids?: string[];
  /** What the AI expects, in plain words. Not simulated. */
  expect?: string;
  /** Lever changes (scenario patches) the idea brings (B4: a play-link visitor's moves). Read through `parsePatches`: anything invalid is dropped. */
  levers?: ScenarioPatch[];
  /** A visitor's idea: the process their link shared, and the version the link was made from. */
  process_id?: string;
  base_revision_id?: string;
};

/** What a decision did: accepting a proposed issue made `issue_id` (and its number); building a solution idea made `solution_id`. */
export type ProposalApplied = { issue_id?: string; number?: number | null; solution_id?: string };

/** A proposed issue or solution idea waiting for a person (docs/PRD.md §5 `suggestion_proposals`). */
export interface ProposalRow {
  id: string;
  workspace_id: string;
  kind: ProposalKind;
  title: string;
  detail: string | null;
  payload: IssueProposalPayload | SolutionIdeaPayload;
  evidence: EvidenceCitation[];
  note: string | null;
  /** The issue a solution idea is for. */
  issue_id: string | null;
  status: ProposalStatus;
  created_via: "mcp" | "play_link" | "upload";
  import_source: string | null;
  /** A play-link visitor's name (B4), or "A visitor" when what they typed names someone, gives an email or an amount. Their email and the held original are not readable by the app's users: owners and editors get them through `play_proposal_contacts`. */
  proposer_name: string | null;
  /** The play link a visitor's idea came from (B4). */
  share_link_id: string | null;
  applied: ProposalApplied | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  created_by: string | null;
}

/** An allowed email domain: managed Google accounts on it join as `member`. */
export interface WorkspaceDomainRow {
  id: string;
  workspace_id: string;
  domain: string;
}

/** A pre-assigned email: whoever signs in with it gets exactly this role. */
export interface AccessEmailRow {
  id: string;
  workspace_id: string;
  email: string;
  role: Exclude<MembershipRole, "agency_admin">;
  person_id: string | null;
}

/** Who can get into a workspace without an invitation (issue #51). */
export interface WorkspaceAccess {
  domains: WorkspaceDomainRow[];
  emails: AccessEmailRow[];
}

type TableRow<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

/** `true` when every field of `Row` is a column of table `T` with a compatible type. */
type Matches<Row, T extends keyof Database["public"]["Tables"]> = [Exclude<keyof Row, keyof TableRow<T>>] extends [never]
  ? Row extends Pick<TableRow<T>, keyof Row & keyof TableRow<T>>
    ? true
    : { mismatch: T }
  : { unknownColumns: Exclude<keyof Row, keyof TableRow<T>> };
type Assert<T extends true> = T;

export type _SchemaDriftChecks = [
  // settings is jsonb; WorkspaceSettings is its app-side shape.
  // provenance is loaded only where shown (optional here, required in the table).
  Assert<Matches<Omit<WorkspaceRow, "settings" | "provenance">, "workspaces">>,
  Assert<Matches<RoleRow, "roles">>,
  Assert<Matches<Omit<PersonRow, "provenance">, "people">>,
  Assert<Matches<PersonRoleRow, "person_roles">>,
  Assert<Matches<PersonSkillRow, "person_skills">>,
  Assert<Matches<PersonLeaveRow, "person_leave">>,
  // is_company and archived_at are optional here (absent on fixtures).
  Assert<Matches<Omit<ProcessRow, "is_company" | "archived_at">, "processes">>,
  Assert<Matches<Required<Pick<ProcessRow, "archived_at">>, "processes">>,
  Assert<Matches<ProcessRevisionRow, "process_revisions">>,
  // replaced_by defaults to '{}' in the table; the app leaves it out of new steps.
  Assert<Matches<Omit<StepRow, "replaced_by">, "steps">>,
  Assert<Matches<EdgeRow, "edges">>,
  // fallback_ongoing_load is jsonb; FallbackLoad is its app-side shape.
  Assert<Matches<Omit<ServiceRow, "provenance">, "services">>,
  // provenance is jsonb; ProvenanceMap is its app-side shape.
  Assert<Matches<ClientRow, "clients">>,
  Assert<Matches<ClientServiceRow, "client_services">>,
  Assert<Matches<ClientAssignmentRow, "client_assignments">>,
  Assert<Matches<ClientGroupRow, "client_groups">>,
  Assert<Matches<FirstPrinciplesRow, "first_principles">>,
  Assert<Matches<AiSettingsRow, "ai_settings">>,
  Assert<Matches<AiAnalysisRow, "ai_analyses">>,
  // origin, status, rating, type and proposed_via are check-constrained.
  Assert<Matches<Omit<FindingRow, "origin" | "status" | "rating" | "type" | "proposed_via">, "findings">>,
  // trigger is check-constrained to the three triggers.
  Assert<Matches<Omit<AiRunRow, "trigger">, "ai_runs">>,
  // recurrence and provenance are jsonb; RecurrenceJson and ProvenanceMap are their app-side shapes.
  Assert<Matches<Omit<ServiceServicingRow, "recurrence">, "service_servicing">>,
  Assert<Matches<LeadSourceRow, "lead_sources">>,
  Assert<Matches<SeasonalityRow, "seasonality">>,
  Assert<Matches<DemandSettingsRow, "demand_settings">>,
  // preset is check-constrained to MarketPreset.
  Assert<Matches<Omit<MarketConditionRow, "preset">, "market_conditions">>,
  Assert<Matches<MarketScheduleRow, "market_schedule">>,
  // driver is check-constrained to ChurnDriverKey; provenance is jsonb.
  Assert<Matches<Omit<ChurnDriverRow, "driver" | "provenance">, "churn_drivers">>,
  Assert<Matches<WorkspaceDomainRow, "workspace_domains">>,
  Assert<Matches<AccessEmailRow, "workspace_access_emails">>,
  // patch is jsonb; ScenarioPatch[] is its checked shape.
  Assert<Matches<Omit<ScenarioRow, "patch">, "scenarios">>,
  // evidence_metrics is jsonb; Record<string, number> is its app-side shape.
  // The three relation arrays are embedded from the link tables.
  Assert<Matches<Omit<IssueRow, "evidence_metrics" | "links" | "owner_ids" | "source_ids" | "status" | "resolved_how">, "issues">>,
  Assert<Matches<Omit<IssueEventRow, "kind" | "detail">, "issue_events">>,
  Assert<Matches<SourceRow, "sources">>,
  // The check constraint limits kind to SourceLinkKind.
  Assert<Matches<Omit<SourceLinkRow, "kind">, "source_links">>,
  // steps is jsonb; BlockBundle is its checked shape, and the check constraint limits type to BlockType.
  Assert<Matches<Omit<BlockRow, "steps" | "type">, "blocks">>,
  // steps, changed_step_ids and lever_changes are jsonb; SolutionRow has their checked shapes. The verdicts are check-constrained.
  Assert<Matches<Omit<SolutionRow, "steps" | "changed_step_ids" | "lever_changes">, "solutions">>,
  Assert<Matches<Omit<SolutionIssueRow, "auto_verdict" | "user_verdict">, "solution_issues">>,
  // markers is jsonb; ForecastPlanRow has its checked shape.
  Assert<Matches<Omit<ForecastPlanRow, "markers">, "forecast_plans">>,
  // patch, evidence and applied are jsonb; the check constraints limit the text columns.
  Assert<Matches<Omit<SuggestionRow, "patch" | "evidence" | "applied">, "suggestions">>,
  // payload, evidence and applied are jsonb; the check constraints limit the text columns.
  Assert<Matches<Omit<ProposalRow, "payload" | "evidence" | "applied" | "kind" | "status" | "created_via">, "suggestion_proposals">>,
];
