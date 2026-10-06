// Share links (issue #32, B3; docs/plans/b3-brief.md, docs/adr/0016-share-links.md): a frozen, redacted copy of the Overview, a
// process, an issue or a solution, which a visitor reads through `public.open_share_link`.
//
// The Next.js server builds the snapshot here, from the same loaders the pages use, through a Db whose team inputs come from
// `public.share_team_capacity` (labels or names, NO pay for anyone). `redactShareSnapshot` then redacts every bundle and every
// string; `shareSnapshotLeaks` is its checker; Postgres checks again on every write (`private.share_snapshot_problem`).
//
// Austin, 6 Oct (#30): members and viewers get no pay data, so no link carries an individual cost rate whatever its toggles.
// Real ids stay in a snapshot: they seed the engine's random streams, so replacing them would move every number (Q5).

import type { FirstPrinciples } from "@transpera-flow/engine";
import { loadFindings } from "./findings";
import { loadFirstPrinciplesFor } from "./first-principles";
import { labelNames, nameFinding, type PersonLabels } from "./person-labels";
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

const NOT_LETTER_OR_DIGIT_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_LETTER_OR_DIGIT_AFTER = "(?![\\p{L}\\p{N}])";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_HIDDEN = "[email hidden]";
const AMOUNT_HIDDEN = "[amount hidden]";
const MIN_NAME = 3;

// Currency symbol forms (£ $ € A$ US$) followed by a number with optional , or . and k/m/bn, or a number and an ISO code.
const NUMBER = "\\d[\\d,]*(?:\\.\\d+)?";
const MAGNITUDE = "(?:\\s?(?:bn|billion|million|thousand|k|m)(?![A-Za-z]))?";
const MONEY = new RegExp(
  `(?<![A-Za-z])(?:US\\$|A\\$|[£$€])\\s?${NUMBER}${MAGNITUDE}|${NUMBER}${MAGNITUDE}\\s?(?:GBP|USD|EUR|AUD|NZD|CAD)(?![A-Za-z])`,
  "gi",
);

const wordRe = (name: string, flags: string) => new RegExp(`${NOT_LETTER_OR_DIGIT_BEFORE}${escapeRe(name)}${NOT_LETTER_OR_DIGIT_AFTER}`, flags);
const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] ?? "";

interface NameMatcher {
  /** Replace each full name with its label (several words: any case; one word: as written). */
  replaceFull(text: string): string;
  /** True when a full name occurs. */
  hasFull(text: string): boolean;
}

/** Full names, longest first, ready to replace or find. Names under three characters are not checked (the floor `labelNames` has). */
function nameMatcher(entries: readonly SecretName[]): NameMatcher {
  const items = entries
    .map((e) => ({ name: e.name.trim(), label: e.label }))
    .filter((e) => e.name.length >= MIN_NAME)
    .sort((a, b) => b.name.length - a.name.length)
    .map((e) => ({ ...e, lower: e.name.toLowerCase(), multi: /\s/.test(e.name), re: wordRe(e.name, /\s/.test(e.name) ? "giu" : "gu") }));
  const needs = (text: string, lower: string, i: (typeof items)[number]) => (i.multi ? lower.includes(i.lower) : text.includes(i.name));
  return {
    replaceFull(text) {
      const lower = text.toLowerCase();
      let out = text;
      for (const i of items) if (needs(text, lower, i)) out = out.replace(i.re, i.label);
      return out;
    },
    hasFull(text) {
      const lower = text.toLowerCase();
      return items.some((i) => needs(text, lower, i) && (i.re.lastIndex = 0, i.re.test(text)));
    },
  };
}

/** First names of 3+ letters, as written. `shared` are the ones two or more people have (`labelNames` leaves those alone). */
function firstNames(people: readonly SecretName[]): { all: string[]; shared: string[] } {
  const count = new Map<string, number>();
  for (const p of people) {
    const f = firstNameOf(p.name);
    if (f.length >= MIN_NAME) count.set(f, (count.get(f) ?? 0) + 1);
  }
  return { all: [...count.keys()], shared: [...count].filter(([, n]) => n > 1).map(([f]) => f) };
}

interface Scrubber {
  text(s: string): string;
}

function scrubber(toggles: ShareToggles, secrets: ShareSecrets): Scrubber {
  const clients = nameMatcher(secrets.clients);
  const labels: PersonLabels = Object.fromEntries(secrets.people.map((p) => [p.label, p.id]));
  const people = secrets.people.map((p) => ({ id: p.id, name: p.name }));
  const { shared } = firstNames(secrets.people);
  const sharedRes = shared.map((f) => wordRe(f, "gu"));
  const needles = secrets.people.flatMap((p) => [p.name.trim().toLowerCase(), firstNameOf(p.name).toLowerCase()]).filter((n) => n.length >= MIN_NAME);
  return {
    text(s) {
      if (s.length < MIN_NAME) return s;
      let t = s;
      if (t.includes("@")) t = t.replace(EMAIL, EMAIL_HIDDEN);
      t = clients.replaceFull(t);
      if (!toggles.people && secrets.people.length) {
        const lower = t.toLowerCase();
        if (needles.some((n) => lower.includes(n))) {
          t = labelNames(t, labels, people);
          // A first name two people share isn't replaced by `labelNames`: it becomes "a team member" (Q11).
          for (const re of sharedRes) t = t.replace(re, "a team member");
        }
      }
      if (!toggles.financials) t = t.replace(MONEY, AMOUNT_HIDDEN);
      return t;
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
  const out: Obj = { ...b, viewer: { seesEveryone: toggles.people, ownPersonId: null }, payHidden: true };
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
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return scrub.text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (!isObj(value)) return value;
    const src = isBundleLike(value) ? redactBundle(value, toggles, secrets) : value;
    const out: Obj = {};
    for (const [k, v] of Object.entries(src)) out[k] = Object.hasOwn(BLANKED, k) ? structuredClone(BLANKED[k]) : walk(v);
    return out;
  };
  const redacted = walk(raw) as Obj;
  return { ...redacted, v: SHARE_SNAPSHOT_VERSION, kind: raw.kind, toggles: { people: toggles.people, financials: toggles.financials }, workspaceName: scrub.text(raw.workspaceName) } as unknown as ShareSnapshot;
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
} as const;
export type ShareLeak = keyof typeof SHARE_LEAKS;

/**
 * The problems left in a snapshot, as `ShareLeak` keys (empty when clean): a non-null `cost_rate`, a non-empty `provenance`, an
 * email, a client's name, with People off a person's full name or first name (shared or not), and with Financials off a rate,
 * margin, overhead or money amount. The database checks full names again (`private.share_snapshot_problem`).
 */
export function shareSnapshotLeaks(snapshot: unknown, secrets: ShareSecrets, toggles: ShareToggles): ShareLeak[] {
  const found = new Set<ShareLeak>();
  const clients = nameMatcher(secrets.clients);
  const people = nameMatcher(secrets.people);
  const firsts = firstNames(secrets.people).all.map((f) => wordRe(f, "u"));
  const s = snapshot as Obj;
  if (
    !isObj(s) ||
    s.v !== SHARE_SNAPSHOT_VERSION ||
    !isObj(s.toggles) ||
    s.toggles.people !== toggles.people ||
    s.toggles.financials !== toggles.financials ||
    !SHARE_KINDS.includes(s.kind as ShareKind)
  ) {
    found.add("mismatch");
  }
  const hasMoney = (t: string) => {
    MONEY.lastIndex = 0;
    return MONEY.test(t);
  };
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (value.includes("@") && (EMAIL.lastIndex = 0, EMAIL.test(value))) found.add("email");
      EMAIL.lastIndex = 0;
      if (clients.hasFull(value)) found.add("client");
      if (!toggles.people && (people.hasFull(value) || firsts.some((re) => re.test(value)))) found.add("person");
      if (!toggles.financials && hasMoney(value)) found.add("money");
      return;
    }
    if (Array.isArray(value)) return void value.forEach((x) => walk(x));
    if (!isObj(value)) return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "cost_rate" && v !== null && v !== undefined) found.add("pay");
      if (k === "provenance" && isObj(v) && Object.keys(v).length) found.add("evidence");
      if (!toggles.financials) {
        if (k === "default_cost_rate" && v !== 0 && v != null) found.add("costs");
        if (k === "margin" && v !== 0 && v != null) found.add("costs");
        if ((k === "overhead_monthly" || k === "target_margin") && v !== undefined) found.add("costs");
      }
      walk(v);
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
    const [scenarios, issues, liveRevisions, solutions, firstPrinciples] = await Promise.all([
      loadScenarios(rdb, ws),
      loadIssuesForReader(rdb, ws),
      loadLiveRevisionIds(rdb, ws),
      loadSolutionsData(rdb, ws, live.process.id),
      firstPrinciplesOf(rdb, live.process.id, live.revision.id),
    ]);
    const findings = await acceptedFindings(rdb, ws, live);
    raw = {
      ...base,
      kind: "process",
      bundle: live,
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
    const probe = await loadProcessBySlug(rdb, workspace.slug);
    if (!probe) throw new ShareBuildError("Publish a process first.");
    const processId = issue.links.find((l) => l.process_id)?.process_id ?? issue.process_id;
    const own = processId && processId !== probe.live.process.id ? await loadProcessBySlug(rdb, workspace.slug, { processId }) : probe;
    const { live, draft } = own ?? probe;
    const bundle = isUnpublished(live) && draft ? draft : live;
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
