// Share links (issue #32, B3; docs/plans/b3-brief.md, docs/adr/0016-share-links.md): a frozen, redacted copy of the Overview, a
// process, an issue or a solution, which a visitor reads through `public.open_share_link`.
//
// The Next.js server builds the snapshot here, from the same loaders the pages use, through a Db whose team inputs come from
// `public.share_team_capacity` (labels or names, NO pay for anyone). `redactShareSnapshot` then redacts every bundle and every
// string; `shareSnapshotLeaks` is its checker; Postgres checks again on every write (`private.share_snapshot_problem`).
//
// Austin, 6 Oct (#30): members and viewers get no pay data, so no link carries an individual cost rate whatever its toggles.
// Real ids stay in a snapshot: they seed the engine's random streams, so replacing them would move every number (Q5).

import { compareRatingsDesc, type FirstPrinciples, type Rating } from "@transpera-flow/engine";
import { loadFindings } from "./findings";
import { shareMoneyRegex } from "./money";
import { loadFirstPrinciplesFor } from "./first-principles";
import { loadLeverSettings } from "./lever-settings";
import { nameFinding } from "./person-labels";
import { EMAIL, MIN_TOKEN, clientNames, clientSpans, nameSpans, nameTokenIndex, normaliseView, pickSpans, replaceSpans, scriptParts, scriptSpans, spansOf, tokens, type Span, type View } from "./share-text";
import {
  isUnpublished,
  listProcesses,
  loadIssuesForReader,
  loadLiveCompanyPart,
  loadLiveParts,
  loadLiveRevisionIds,
  loadProcessBySlug,
  loadProcessBundle,
  loadScenarios,
  loadSolutionIssues,
  loadSolutions,
  type Db,
} from "./queries";
import { partitionSteps } from "./retired";
import type {
  EdgeRow,
  FindingRow,
  IssueRow,
  ProcessBundle,
  ProcessPart,
  ProcessRevisionRow,
  ScenarioRow,
  SolutionRow,
  SolutionsData,
  StepRow,
  WorkspaceRow,
} from "./types";

export const SHARE_SNAPSHOT_VERSION = 1;

/**
 * The lever kinds of `apps/web/src/lib/scenarios/lever-catalogue.ts` (LEVER_KINDS), in its order. A copy, because this package
 * imports nothing from the app: a web test asserts it equals the catalogue's ids and a database test asserts it equals
 * `private.lever_kind_ids()`. A play link's `hiddenLevers` holds only these.
 */
export const LEVER_KIND_IDS: readonly string[] = [
  "demand.enquiries", "demand.conversion", "demand.seasonal", "demand.growth", "people.headcount", "people.hours",
  "people.starters", "people.leave", "process.time", "process.wait", "process.rework", "process.routing", "clients.count",
  "clients.fee", "clients.churn", "clients.causes", "finances.prices", "finances.roleCost", "finances.fixed",
  "market.conditions", "market.schedule",
];

/** Only known kind ids, in catalogue order, no repeats (the app's `cleanHidden`). */
export function cleanHiddenLevers(ids: readonly unknown[]): string[] {
  const set = new Set(ids.filter((x): x is string => typeof x === "string"));
  return LEVER_KIND_IDS.filter((id) => set.has(id));
}

/** A snapshot's `hiddenLevers` is valid when absent, or an array of at most 30 distinct known kind ids (the database's rule). */
export function validHiddenLevers(v: unknown): boolean {
  if (v === undefined) return true;
  if (!Array.isArray(v) || v.length > 30) return false;
  return v.every((x) => typeof x === "string" && LEVER_KIND_IDS.includes(x)) && new Set(v).size === v.length;
}

export type ShareKind = "overview" | "process" | "issue" | "solution";
export const SHARE_KINDS: readonly ShareKind[] = ["overview", "process", "issue", "solution"];

export interface ShareToggles {
  /** Real names. Off: "Team member N". Never pay either way. */
  people: boolean;
  /** Role rates, margins, overhead. Off: they are zero or absent and money in text is hidden. */
  financials: boolean;
}

interface ShareSnapshotBase {
  v: 1;
  kind: ShareKind;
  toggles: ShareToggles;
  workspaceName: string;
}

type Graph = { steps: StepRow[]; edges: EdgeRow[] };
type ProcessName = { id: string; name: string };

export interface OverviewShare extends ShareSnapshotBase {
  kind: "overview";
  live: ProcessBundle;
  parts: ProcessPart[];
  company: ProcessPart | null;
  issues: IssueRow[];
  solutions: SolutionsData;
  /** For each solution copied from an earlier version than live: that version's steps and edges, for the before and after. */
  solutionBases: Record<string, Graph>;
  findings: FindingRow[];
  firstPrinciples: FirstPrinciples | null;
}

export interface ProcessShare extends ShareSnapshotBase {
  kind: "process";
  bundle: ProcessBundle;
  /** The lever kinds the workspace hides (Settings → Levers), frozen with the copy. A play link's visitor is offered the others. */
  hiddenLevers: string[];
  processes: { id: string; name: string; parentId: string | null; kind: "pipeline" | "servicing" }[];
  scenarios: ScenarioRow[];
  issues: IssueRow[];
  liveRevisions: Record<string, string>;
  solutions: SolutionsData;
  findings: FindingRow[];
  firstPrinciples: FirstPrinciples | null;
}

export interface IssueShare extends ShareSnapshotBase {
  kind: "issue";
  issueId: string;
  bundle: ProcessBundle;
  issues: IssueRow[];
  processes: ProcessName[];
  liveRevisions: Record<string, string>;
  solutions: SolutionsData;
}

export interface SolutionShare extends ShareSnapshotBase {
  kind: "solution";
  solutionId: string;
  bundle: ProcessBundle;
  solutions: SolutionsData;
  issues: IssueRow[];
  processes: ProcessName[];
  /** The version the solution was copied from: its revision, steps and edges (the rest of the bundle is the live one's). */
  compareBase: { revision: ProcessRevisionRow; steps: StepRow[]; edges: EdgeRow[]; retired?: StepRow[] } | null;
  /** A sentence when the process has been published since the solution was copied from it. */
  movedOn: string | null;
}

export type ShareSnapshot = OverviewShare | ProcessShare | IssueShare | SolutionShare;

/** A person or client of the workspace, with the label a share link shows for them. Never put in a snapshot. */
export interface SecretName {
  id: string;
  name: string;
  label: string;
}
export interface ShareSecrets {
  people: SecretName[];
  clients: SecretName[];
}

/** What can't be shared, in words for the dialog. */
export class ShareBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareBuildError";
  }
}

// ---------------------------------------------------------------------------
// The Db a snapshot is read through
// ---------------------------------------------------------------------------

/**
 * A `Db` that changes exactly two rpc calls and nothing else: `team_capacity` becomes `share_team_capacity` (labels or names
 * by the People toggle, and no pay for anyone), and `can_see_people` answers the People toggle. Every other call passes
 * through, so the loaders read as the editor who makes the link (RLS) and build exactly what the pages build.
 */
export function shareReaderDb(db: Db, toggles: ShareToggles): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "rpc") {
        return (fn: string, args?: unknown, options?: unknown) => {
          if (fn === "team_capacity") {
            const ws = (args as { ws: string } | undefined)?.ws;
            return (target.rpc as (...a: unknown[]) => unknown)("share_team_capacity", { ws, show_people: toggles.people }, options);
          }
          if (fn === "can_see_people") return Promise.resolve({ data: toggles.people, error: null });
          return (target.rpc as (...a: unknown[]) => unknown)(fn, args, options);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// Names and money
// ---------------------------------------------------------------------------

const EMAIL_HIDDEN = "[email hidden]";
const AMOUNT_HIDDEN = "[amount hidden]";
const MIN_NAME = MIN_TOKEN;

/**
 * The keys known to hold free text a person wrote, or a name. DOCUMENTATION and the tests' reference only: the redaction treats any
 * string under a key that is not on `SHARE_NON_TEXT_KEYS` as free text (default deny), in the app and in the database.
 */
export const SHARE_FREE_TEXT_KEYS: readonly string[] = [
  "actor", "entity_name", "quote", "auto_note", "body", "breaks_if_removed", "chain", "done", "message", "owner_text", "problem", "progress", "root", "situation", "source", "statement", "test", "who", "horizon", "description", "detail", "domain", "evidence", "example", "excerpt", "expect", "job_done",
  "job_progress", "job_situation", "job_who", "label", "movedOn", "name", "note", "notes", "proposer_name", "reason", "review_note",
  "resolution_note", "root_cause", "speaker", "speakers", "summary", "target_goal", "target_measure", "target_now", "text", "title", "tool",
  "user_name", "user_notes", "why", "why_problem", "workspaceName",
];
/**
 * The keys that hold a string but never free text: ids, dates, enums, selectors and paths the engine reads. Every OTHER string is
 * free text and is scrubbed and checked, so a key nobody classified (a new column, a new field) fails closed: its names are hidden.
 * A key that is text anywhere (`source` is an enum on an issue and text on a first-principles statement) stays off this list.
 * A test derives every string column of every table from the database types and fails on one that is not classified.
 * `condition_tag` and `path_tags` are text: a name in a tag becomes its label on both sides (an edge and the services it
 * routes to carry the same tag), so the tags still match and the numbers stay equal.
 */
export const SHARE_NON_TEXT_KEYS: readonly string[] = [
  "agreed_by", "kpi",
  "ai_key", "analysis_id", "archived_at", "archived_by", "at", "auto_verdict", "base_revision_id", "by",
  "child_process_id", "client_id", "color", "comparator", "condition_id", "created_at", "created_by", "currency",
  "dataset_id", "decided_at", "decided_by", "detected_key", "dismissed_revision_id", "draft_revision_id", "driver",
  "end_date", "entry_process_id", "entry_step_id", "every", "file_url", "from_step_id", "hiddenLevers", "id", "import_source",
  "input_hash", "insight_key", "issueId", "issue_id", "key", "kind", "linked_parameter", "live_revision_id",
  "market_pending_at", "model", "model_hash", "op", "origin", "outcome", "owner_ids", "owner_person_id",
  "parent_process_id", "parent_scenario_id", "parent_step_id", "path", "person_id", "plan", "preset", "pricing_model",
  "process_id", "proposed_via", "published_at", "published_by", "rating", "recorded_at", "replaced_by",
  "replaces_step_ids", "resolution", "resolved_at", "resolved_how", "resolved_solution_id", "reviewed_at", "reviewed_by",
  "revision_id", "rework_to_step_id", "role_id", "run_id", "scenario_id", "service_id", "severity", "slug", "solutionId",
  "solution_id", "source_id", "source_ids", "stage", "start_date", "started_at", "status", "step_id", "suggestion_id",
  "timestamp", "to_step_id", "type", "updated_at", "updated_by", "user_id", "user_verdict", "verdict", "wait_dist",
  "work_dist", "workspace_id",
];
const NON_TEXT = new Set(SHARE_NON_TEXT_KEYS);
/** Free text unless the key says otherwise (default deny). */
const isFree = (key: string): boolean => !NON_TEXT.has(key);

/** Ids, dates and plain numbers hold nothing to hide: skipped, for speed. */
const QUIET = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[\d\-:.TZ+ ]*)$/i;

/** What a share link hides, as the spans of one string's original text. Shared by the scrub and the check, so they can't disagree. */
function spansFor(toggles: ShareToggles, secrets: ShareSecrets) {
  const people = nameTokenIndex([{ kind: "person", entries: secrets.people }]);
  const scripts = scriptParts(secrets.people);
  const clientScripts = scriptParts(secrets.clients, true);
  const clients = clientNames(secrets.clients);
  const email = [{ re: EMAIL, label: EMAIL_HIDDEN }];
  const money = [{ re: shareMoneyRegex(), label: AMOUNT_HIDDEN }];
  return (view: View, free: boolean): Span[] => [
    ...spansOf(view, email),
    ...(toggles.financials ? [] : spansOf(view, money)),
    // A client only by the whole of its name; a person by any part of theirs.
    ...(free ? [...clientSpans(view, clients), ...scriptSpans(view, clientScripts)] : []),
    ...(free && !toggles.people ? [...nameSpans(view, people, () => true), ...scriptSpans(view, scripts)] : []),
  ];
}

interface Scrubber {
  /** `free`: the string is free text (its key is on `SHARE_FREE_TEXT_KEYS`), so names are looked for in it too. */
  text(s: string, free: boolean): string;
}

function scrubber(toggles: ShareToggles, secrets: ShareSecrets): Scrubber {
  const spans = spansFor(toggles, secrets);
  return {
    text(s, free) {
      if (s.length < MIN_NAME || QUIET.test(s)) return s;
      return replaceSpans(s, pickSpans(spans(normaliseView(s), free)));
    },
  };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Looks like a `ProcessBundle`: the thing that carries people, clients, roles, services and settings. */
function isBundleLike(v: Obj): boolean {
  return isObj(v.workspace) && Array.isArray(v.people) && Array.isArray(v.roles) && Array.isArray(v.steps) && isObj(v.process);
}

const GUARDED_SETTINGS = ["overhead_monthly", "target_margin"] as const;
const PERSON_NUMBER = /^Team member \d+$/;

function redactBundle(b: Obj, toggles: ShareToggles, secrets: ShareSecrets): Obj {
  const personLabel = new Map(secrets.people.map((p) => [p.id, p.label]));
  const clientLabel = new Map(secrets.clients.map((c) => [c.id, c.label]));
  // `personCapacityFactors: []` (C6): no link carries anyone's per-person times, whatever its toggles (D20). The list is already
  // empty (`share_team_capacity` has none); this is defence in depth.
  const out: Obj = { ...b, viewer: { seesEveryone: toggles.people, ownPersonId: null }, payHidden: true, personCapacityFactors: [] };
  out.people = (b.people as Obj[]).map((p) => ({
    ...p,
    name: toggles.people ? p.name : (personLabel.get(String(p.id)) ?? (PERSON_NUMBER.test(String(p.name)) ? p.name : "A team member")),
    cost_rate: null,
    provenance: {},
  }));
  if (Array.isArray(b.clients)) {
    out.clients = (b.clients as Obj[]).map((c) => ({ ...c, name: clientLabel.get(String(c.id)) ?? "A client", notes: null, provenance: {} }));
  }
  if (!toggles.financials) {
    out.roles = (b.roles as Obj[]).map((r) => ({ ...r, default_cost_rate: 0 }));
    if (Array.isArray(b.services)) out.services = (b.services as Obj[]).map((s) => ({ ...s, margin: 0 }));
  }
  const ws = b.workspace as Obj;
  const settings = isObj(ws.settings) ? { ...ws.settings } : ws.settings;
  if (!toggles.financials && isObj(settings)) for (const k of GUARDED_SETTINGS) delete settings[k];
  out.workspace = { ...ws, settings, slug: "", provenance: {} };
  return out;
}

/** Keys whose value never goes into a snapshot, and what stands in for it. */
/** A role-rate change (`roles.<id>.cost_rate`) inside a scenario's patch or a solution's lever changes: the visitor's browser would price work at the real rate. */
const isRatePatch = (v: unknown): boolean => isObj(v) && typeof v.path === "string" && /cost_rate$/.test(v.path);
/** A fact of a finding that quotes a source word for word. */
const isQuoteFact = (v: unknown): boolean => isObj(v) && v.kind === "quote";

const BLANKED: Record<string, unknown> = {
  provenance: {},
  cost_rate: null,
  created_by: null,
  updated_by: null,
  decided_by: null,
  person_labels: {},
  // Sources aren't part of a snapshot: nothing to link to.
  source_ids: [],
};

/**
 * The snapshot with everything a toggle hides taken out: every bundle (viewer, `payHidden`, people, clients, rates, margins,
 * settings), every `provenance`, and every string (emails, client names, and with People off people's names, with Financials off
 * money). `raw` is what `loadShareData` built; this is pure.
 */
export function redactShareSnapshot(raw: ShareSnapshot, toggles: ShareToggles, secrets: ShareSecrets): ShareSnapshot {
  const scrub = scrubber(toggles, secrets);
  const walk = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") return scrub.text(value, isFree(key));
    if (Array.isArray(value)) return value.map((x) => walk(x, key));
    if (!isObj(value)) return value;
    const src = isBundleLike(value) ? redactBundle(value, toggles, secrets) : value;
    const out: Obj = {};
    for (const [k, v] of Object.entries(src)) {
      // Per-person times (C6) never go out, wherever they sit: an engine person's `capacityFactor` is dropped, a list is emptied.
      if (k === "capacityFactor") continue;
      if (k === "personCapacityFactors" || k === "person_capacity_factors") out[k] = [];
      else if (Object.hasOwn(BLANKED, k)) out[k] = structuredClone(BLANKED[k]);
      // A step's own cost figure: a money field, hidden with Financials off.
      else if (k === "cost_override" && !toggles.financials) out[k] = null;
      // Word-for-word quotes from sources never go out (they name people and clients as the speaker said them).
      else if (k === "facts" && Array.isArray(v)) out[k] = v.filter((f) => !isQuoteFact(f)).map((x) => walk(x, k));
      // With Financials off, no role-rate change in a scenario's patch or a solution's lever changes.
      else if (!toggles.financials && (k === "patch" || k === "lever_changes") && Array.isArray(v)) out[k] = v.filter((p) => !isRatePatch(p)).map((x) => walk(x, k));
      else out[k] = walk(v, k);
    }
    return out;
  };
  const redacted = walk(raw) as Obj;
  return { ...redacted, v: SHARE_SNAPSHOT_VERSION, kind: raw.kind, toggles: { people: toggles.people, financials: toggles.financials }, workspaceName: scrub.text(raw.workspaceName, true) } as unknown as ShareSnapshot;
}

// ---------------------------------------------------------------------------
// The checker (the TypeScript twin of private.share_snapshot_problem)
// ---------------------------------------------------------------------------

/** What leaked, in words. Never the leaked value. */
export const SHARE_LEAKS = {
  mismatch: "The snapshot doesn't match the link.",
  email: "The snapshot contains an email address.",
  pay: "The snapshot contains a person's pay.",
  evidence: "The snapshot contains evidence notes.",
  client: "The snapshot names a client.",
  person: "The snapshot names a person.",
  costs: "The snapshot contains costs or margins.",
  money: "The snapshot contains a money amount.",
  speeds: "The snapshot contains per-person times.",
} as const;
export type ShareLeak = keyof typeof SHARE_LEAKS;

/**
 * The problems left in a snapshot, as `ShareLeak` keys (empty when clean): a non-null `cost_rate`, a non-empty `provenance`, an
 * email, a client's name, with People off a person's full name or first name (shared or not), and with Financials off a rate,
 * margin, overhead or money amount. The database checks full names again (`private.share_snapshot_problem`).
 */
export function shareSnapshotLeaks(snapshot: unknown, secrets: ShareSecrets, toggles: ShareToggles): ShareLeak[] {
  const found = new Set<ShareLeak>();
  const email = [{ re: EMAIL, label: "" }];
  const money = [{ re: shareMoneyRegex(), label: "" }];
  const people = nameTokenIndex([{ kind: "person", entries: secrets.people }]);
  const scripts = scriptParts(secrets.people);
  const clientScripts = scriptParts(secrets.clients, true);
  const clients = clientNames(secrets.clients);
  const s = snapshot as Obj;
  if (
    !isObj(s) ||
    s.v !== SHARE_SNAPSHOT_VERSION ||
    !isObj(s.toggles) ||
    s.toggles.people !== toggles.people ||
    s.toggles.financials !== toggles.financials ||
    !SHARE_KINDS.includes(s.kind as ShareKind) ||
    // B4: the kinds a play link hides are known kind ids, so the key can't carry text.
    !validHiddenLevers(s.hiddenLevers)
  ) {
    found.add("mismatch");
  }
  // Emails and money: every string value. Names: the free-text values only, token by token on the same normalised view the
  // scrub used, so any name token left (next to a label or not) is a leak. Keys are never looked at for text.
  const text = (value: string, free: boolean) => {
    if (value.length < MIN_NAME) return;
    const view = normaliseView(value);
    if (spansOf(view, email).length) found.add("email");
    if (!toggles.financials && spansOf(view, money).length) found.add("money");
    if (!free) return;
    if (clientSpans(view, clients).length || scriptSpans(view, clientScripts).length) found.add("client");
    if (toggles.people) return;
    if (scriptSpans(view, scripts).length) found.add("person");
    for (const t of tokens(view)) {
      const name = people.get(t.text);
      if (name && !name.glue) found.add("person");
    }
  };
  const walk = (value: unknown, key = "", depth = 0) => {
    if (typeof value === "string") return text(value, isFree(key));
    if (Array.isArray(value)) return void value.forEach((x) => walk(x, key, depth));
    if (!isObj(value)) return;
    for (const [k, v] of Object.entries(value)) {
      // `hiddenLevers` is a non-text key wherever it sits, so it may appear only once, at the top: a copy nested elsewhere would skip the name checks.
      if (k === "hiddenLevers" && depth > 0) found.add("mismatch");
      if (k === "cost_rate" && v !== null && v !== undefined) found.add("pay");
      // Per-person times (C6): any capacityFactor key, or a non-empty list of them, anywhere.
      if (k === "capacityFactor") found.add("speeds");
      if ((k === "personCapacityFactors" || k === "person_capacity_factors") && Array.isArray(v) && v.length) found.add("speeds");
      // Evidence notes of any JSON type: only an empty object (or null) is clean.
      if (k === "provenance" && v !== null && v !== undefined && !(isObj(v) && Object.keys(v).length === 0)) found.add("evidence");
      if (k === "facts" && Array.isArray(v) && v.some(isQuoteFact)) found.add("evidence");
      if (!toggles.financials) {
        if (k === "default_cost_rate" && v !== 0 && v != null) found.add("costs");
        if (k === "margin" && v !== 0 && v != null) found.add("costs");
        if (k === "cost_override" && v !== null && v !== undefined) found.add("costs");
        if ((k === "overhead_monthly" || k === "target_margin") && v !== undefined) found.add("costs");
        if ((k === "patch" || k === "lever_changes") && Array.isArray(v) && v.some(isRatePatch)) found.add("costs");
      }
      walk(v, k, depth + 1);
    }
  };
  walk(snapshot);
  return [...found];
}

// ---------------------------------------------------------------------------
// Building a snapshot
// ---------------------------------------------------------------------------

type Workspace = Pick<WorkspaceRow, "id" | "name" | "slug"> & { settings: unknown };

/** The real names and ids of the workspace's people and clients, read as the editor. Used to redact and check; never saved. */
export async function loadShareSecrets(db: Db, workspaceId: string): Promise<ShareSecrets> {
  const [people, clients] = await Promise.all([
    db.from("people").select("id, name, created_at").eq("workspace_id", workspaceId),
    db.from("clients").select("id, name, created_at").eq("workspace_id", workspaceId),
  ]);
  if (people.error) throw people.error;
  if (clients.error) throw clients.error;
  // The numbering `share_team_capacity` and `team_capacity` use: (created_at, id) over every person, active or not.
  const rank = (rows: { id: string; name: string; created_at: string }[], prefix: string): SecretName[] =>
    [...rows]
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r, i) => ({ id: r.id, name: r.name, label: `${prefix} ${i + 1}` }));
  return { people: rank(people.data, "Team member"), clients: rank(clients.data, "Client") };
}

async function loadRevisionGraph(db: Db, revisionId: string): Promise<Graph> {
  const [steps, edges] = await Promise.all([db.from("steps").select("*").eq("revision_id", revisionId), db.from("edges").select("*").eq("revision_id", revisionId)]);
  if (steps.error) throw steps.error;
  if (edges.error) throw edges.error;
  return { steps: partitionSteps(steps.data as unknown as StepRow[]).steps, edges: edges.data as unknown as EdgeRow[] };
}

async function loadSolutionsData(db: Db, ws: string, processId?: string): Promise<SolutionsData> {
  const [solutions, links] = await Promise.all([loadSolutions(db, ws, processId), loadSolutionIssues(db, ws)]);
  const ids = new Set(solutions.map((s) => s.id));
  // `aiIds` (which solutions came from an AI idea) is left out: AI ideas aren't shared, so every solution reads "By hand".
  return { solutions, links: links.filter((l) => ids.has(l.solution_id)) };
}

async function firstPrinciplesOf(db: Db, processId: string, revisionId: string): Promise<FirstPrinciples | null> {
  try {
    return (await loadFirstPrinciplesFor(db, processId, [revisionId]))[revisionId]?.doc ?? null;
  } catch {
    return null;
  }
}

/** The accepted findings, named for the snapshot's own viewer (labels with People off). */
async function acceptedFindings(db: Db, ws: string, bundle: ProcessBundle): Promise<FindingRow[]> {
  return (await loadFindings(db, ws, ["accepted"])).map((f) => nameFinding(f, { viewer: bundle.viewer, people: bundle.people }));
}

/**
 * Builds the snapshot of one page for a share link, as the caller of `db` (an owner, editor or agency admin: RLS and
 * `share_team_capacity` refuse anyone else). Mirrors each page's data and leaves out what the brief lists: sources, AI views,
 * proposed findings, AI ideas, issue history, author names, drafts and earlier versions. Throws `ShareBuildError` for a page
 * that can't be shared. The result is already redacted; call `shareSnapshotLeaks` on it before saving.
 */
export async function loadShareData(
  db: Db,
  workspace: Workspace,
  target: { kind: ShareKind; id: string | null },
  toggles: ShareToggles,
): Promise<ShareSnapshot> {
  const rdb = shareReaderDb(db, toggles);
  const ws = workspace.id;
  const secrets = await loadShareSecrets(db, ws);
  const base = { v: SHARE_SNAPSHOT_VERSION, toggles, workspaceName: workspace.name } as const;

  let raw: ShareSnapshot;
  if (target.kind === "overview") {
    const first = await loadProcessBySlug(rdb, workspace.slug, { draft: false });
    const live = first?.live;
    if (!live || isUnpublished(live)) throw new ShareBuildError("Publish a process first: the Overview has nothing to show yet.");
    const [parts, company, issues, solutions, firstPrinciples] = await Promise.all([
      loadLiveParts(rdb, ws),
      loadLiveCompanyPart(rdb, ws),
      loadIssuesForReader(rdb, ws),
      loadSolutionsData(rdb, ws),
      firstPrinciplesOf(rdb, live.process.id, live.revision.id),
    ]);
    const findings = await acceptedFindings(rdb, ws, live);
    const liveRevision = new Map(parts.map((p) => [p.process.id, p.revision.id]));
    const older = solutions.solutions.filter((s) => liveRevision.has(s.process_id) && liveRevision.get(s.process_id) !== s.base_revision_id);
    const graphs = await Promise.all(older.map((s) => loadRevisionGraph(rdb, s.base_revision_id).catch(() => null)));
    const solutionBases: Record<string, Graph> = Object.fromEntries(older.flatMap((s, i) => (graphs[i] ? [[s.id, graphs[i]!]] : [])));
    raw = { ...base, kind: "overview", live, parts, company, issues, solutions, solutionBases, findings, firstPrinciples };
  } else if (target.kind === "process") {
    const row = await db.from("processes").select("id, workspace_id, is_company, archived_at, live_revision_id").eq("id", target.id ?? "").eq("workspace_id", ws).maybeSingle();
    if (row.error) throw row.error;
    if (!row.data) throw new ShareBuildError("That process isn't here any more.");
    if (row.data.is_company) throw new ShareBuildError("Share the Overview instead.");
    if (row.data.archived_at) throw new ShareBuildError("An archived process can't be shared. Restore it first.");
    if (!row.data.live_revision_id) throw new ShareBuildError("Publish this process first: a link shows the published version.");
    const loaded = await loadProcessBySlug(rdb, workspace.slug, { draft: false, processId: row.data.id });
    if (!loaded || isUnpublished(loaded.live)) throw new ShareBuildError("That process isn't here any more.");
    const live = loaded.live;
    const [scenarios, issues, liveRevisions, solutions, firstPrinciples, leverSettings] = await Promise.all([
      loadScenarios(rdb, ws),
      loadIssuesForReader(rdb, ws),
      loadLiveRevisionIds(rdb, ws),
      loadSolutionsData(rdb, ws, live.process.id),
      firstPrinciplesOf(rdb, live.process.id, live.revision.id),
      loadLeverSettings(rdb, ws),
    ]);
    const findings = await acceptedFindings(rdb, ws, live);
    raw = {
      ...base,
      kind: "process",
      bundle: live,
      hiddenLevers: cleanHiddenLevers(leverSettings.hidden),
      processes: loaded.processes.map((p) => ({ id: p.id, name: p.name, parentId: p.parentId ?? null, kind: p.kind })),
      scenarios,
      issues,
      liveRevisions,
      solutions,
      findings,
      firstPrinciples,
    };
  } else if (target.kind === "issue") {
    const issues = await loadIssuesForReader(rdb, ws);
    const issue = issues.find((i) => i.id === target.id && i.number != null);
    if (!issue) throw new ShareBuildError("That issue isn't here any more.");
    // Any process the issue is on (its own or a link) being archived refuses the link, before anything else is loaded.
    await refuseArchived(db, ws, [issue.process_id, ...issue.links.map((l) => l.process_id)]);
    // Only a published version is ever shared, never a draft.
    const probe = await loadProcessBySlug(rdb, workspace.slug, { draft: false });
    if (!probe) throw new ShareBuildError("Publish a process first.");
    const processId = issue.links.find((l) => l.process_id)?.process_id ?? issue.process_id;
    const own = processId && processId !== probe.live.process.id ? await loadProcessBySlug(rdb, workspace.slug, { processId, draft: false }) : probe;
    // The issue's own process must be published; falling back to another process would show the wrong map.
    if (processId && processId !== probe.live.process.id && !own) throw new ShareBuildError("Publish this process first: a link shows the published version.");
    const bundle = (own ?? probe).live;
    if (isUnpublished(bundle)) throw new ShareBuildError("Publish this process first: a link shows the published version.");
    const [processes, liveRevisions, solutions] = await Promise.all([
      listProcesses(rdb, ws).then((ps) => ps.map((p) => ({ id: p.id, name: p.name }))),
      loadLiveRevisionIds(rdb, ws),
      loadSolutionsData(rdb, ws),
    ]);
    raw = { ...base, kind: "issue", issueId: issue.id, bundle, issues, processes, liveRevisions, solutions };
  } else {
    const all = await loadSolutionsData(rdb, ws);
    const solution = all.solutions.find((s) => s.id === target.id);
    if (!solution) throw new ShareBuildError("That solution isn't here any more.");
    await refuseArchived(db, ws, [solution.process_id]);
    const [issues, processes] = await Promise.all([loadIssuesForReader(rdb, ws), listProcesses(rdb, ws).then((ps) => ps.map((p) => ({ id: p.id, name: p.name })))]);
    const loaded = (await loadProcessBySlug(rdb, workspace.slug, { draft: false, processId: solution.process_id })) ?? (await loadProcessBySlug(rdb, workspace.slug, { draft: false }));
    if (!loaded) throw new ShareBuildError("Publish a process first.");
    const live = loaded.live;
    let compareBase: SolutionShare["compareBase"] = null;
    let movedOn: string | null = null;
    try {
      if (live.process.id === solution.process_id) {
        if (live.revision.id === solution.base_revision_id) {
          compareBase = { revision: live.revision, steps: live.steps, edges: live.edges, retired: live.retired ?? [] };
        } else {
          const earlier = await loadProcessBundle(rdb, live.workspace, live.process, solution.base_revision_id);
          compareBase = { revision: earlier.revision, steps: earlier.steps, edges: earlier.edges, retired: earlier.retired ?? [] };
          movedOn = `Live has moved on since: this solution was copied from version ${earlier.revision.number}, and live is now version ${live.revision.number}. “Live” here is version ${earlier.revision.number}, so the maps and numbers show exactly what the solution changed.`;
        }
      }
    } catch {
      compareBase = null;
    }
    const mine: SolutionRow[] = [solution];
    const solutions: SolutionsData = { solutions: mine, links: all.links.filter((l) => l.solution_id === solution.id) };
    raw = { ...base, kind: "solution", solutionId: solution.id, bundle: live, solutions, issues, processes, compareBase, movedOn };
  }
  return redactShareSnapshot(raw, toggles, secrets);
}

/** An archived process can't be shared on any path: an issue or a solution of one is as much a view of it as its own link. */
async function refuseArchived(db: Db, workspaceId: string, processIds: readonly (string | null | undefined)[]): Promise<void> {
  const ids = [...new Set(processIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  const { data, error } = await db.from("processes").select("id, archived_at").eq("workspace_id", workspaceId).in("id", ids);
  if (error) throw error;
  if ((data ?? []).some((p) => p.archived_at)) throw new ShareBuildError("An archived process can't be shared. Restore it first.");
}

/**
 * Detected issues in the order a share link without Financials reads them: worst rating first, then by key. No cost decides it,
 * money or hours: the editor's order puts the dearest first, which needs the role rates and pay a link hides (and ordering by
 * pay-derived costs would leak their rank), and a pay-dependent cost has no hours either in a link. Sorted this way an editor
 * and a visitor read the same list in the same order.
 */
export function sortWithoutMoney<T extends { key: string; rating: Rating }>(list: readonly T[]): T[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...list].sort((a, b) => compareRatingsDesc(a.rating, b.rating) || cmp(a.key, b.key));
}
