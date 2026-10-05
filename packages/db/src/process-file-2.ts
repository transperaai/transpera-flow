// What `transpera-process/2` adds to the /1 file (issue #167, B14): evidence for every number, a list of sources, facts about
// the company, proposed issues and ideas, and first principles. The steps, links and groups are checked in process-file.ts
// (shared with /1); this module checks the new parts and holds their types, schema pieces and the prompt's extra rules.
// Pure: no I/O and no framework.
//
// A file never changes anything live. Company facts become suggestions, proposals become proposals, and both wait for a
// person; first principles go to the new draft; sources are added and linked to the process.

// The engine's lists (ratings, issue types, first-principles values, success measures) are written out here, not imported: this
// module and the schema generator (scripts/gen-import-schema.ts) run under plain Node, which can't load the engine's source. A
// test (process-file-2.test.ts) fails if any list drifts from the engine's.

import { isObject, norm, q, suggest } from "@transpera-flow/db/process-file-util";

export const PROCESS_FILE_FORMAT_2 = "transpera-process/2";

export const RATINGS = ["great", "good", "bad", "risk"] as const;
export const ISSUE_TYPES = ["bottleneck", "spof", "manual", "delay", "failure", "idea", "capacity", "sla", "churn_risk", "perception_gap", "broken_scenario"] as const;
export const FP_KINDS = ["truth", "assumption"] as const;
export const FP_VERDICTS = ["keep", "change", "drop", "challenge"] as const;
export const FP_COMPARATORS = ["atLeast", "atMost"] as const;
export const SUCCESS_KPI_KEYS = ["won", "winsPerWeek", "winRate", "newMrr", "billed", "cycleHours", "labour", "wipEnd"] as const;
const FP_MAX_ITEMS = 50;
const FP_MAX_CHAIN = 10;

export const SOURCE_KINDS = ["transcript", "notes", "data", "screenshot"] as const;
export type FileSourceKind = (typeof SOURCE_KINDS)[number];

export const MAX_FILE_SOURCES = 50;
const MAX_QUOTE = 2000;
const MAX_CITATIONS = 10;
const MAX_REASON = 2000;
const MAX_BODY = 500_000;
const MAX_COMPANY_ITEMS = 100;
const MAX_PROPOSALS = 50;
const MAX_TEXT = 2000;
/** Most suggestions one file can ask for in all (the review page lists each). */
export const MAX_FILE_SUGGESTIONS = 300;

/** The step fields that can carry evidence, as the file names them. */
export const EVIDENCE_FIELDS = ["hands_on_hours", "wait_hours", "rework_rate", "waiting_now", "sla_hours"] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

/** What each evidence field is called in a sentence. */
export const EVIDENCE_FIELD_WORDS: Record<EvidenceField, string> = {
  hands_on_hours: "hands-on time",
  wait_hours: "wait",
  rework_rate: "rework rate",
  waiting_now: "items waiting now",
  sla_hours: "SLA",
};

/** One quote that backs a value: the words, where they are from and who said them. */
export interface FileCitation {
  /** The id of a source in the file's `sources`. */
  source: string;
  quote: string;
  speaker?: string;
  /** Where in the source: a time in a recording ("00:14:05"), a page, a date. */
  time?: string;
  /** The number they stated, in the field's units, when they stated one. Different values for one field are a conflict. */
  value?: number;
}

/** Evidence, or the reason a value is assumed. A value with neither is simply stated by the file. */
export interface Backing {
  evidence: FileCitation[];
  assumed?: string;
}

export interface FileSource {
  id: string;
  title: string;
  kind: FileSourceKind;
  /** ISO date (YYYY-MM-DD). */
  date?: string;
  speakers: string[];
  /** The text itself, when the file carries it (optional; a long transcript is better left out). */
  body?: string;
}

export interface FileRange {
  min: number;
  max: number;
}

export interface FilePerson extends Backing {
  name: string;
  roles?: string[];
  fte?: number;
  hours_per_week?: number;
  cost_rate?: number;
  email?: string;
  start_date?: string;
  leave?: { start_date: string; end_date: string; note?: string }[];
}
export interface FileRole extends Backing {
  name: string;
}
export interface FileClient extends Backing {
  name: string;
  services?: string[];
  mrr?: number;
  start_date?: string;
  health?: number;
  notes?: string;
  active?: boolean;
  assignments?: Record<string, string>;
}
export interface FileService extends Backing {
  name: string;
  pricing_model?: "retainer" | "one_off" | "hourly";
  price?: number;
  margin?: number;
  tenure_months?: number;
  monthly_churn?: number;
  mix_share?: number;
}
export interface FileLeadSource extends Backing {
  name: string;
  volume_per_week?: number;
  conversion_to_qualified?: number;
}
export interface FileDemand extends Backing {
  lead_sources: FileLeadSource[];
  growth_monthly?: number;
  seasonality?: number[];
}

/** Facts about the company. Each becomes a suggestion for a person to accept or reject. */
export interface FileCompany {
  people: FilePerson[];
  roles: FileRole[];
  clients: FileClient[];
  services: FileService[];
  demand?: FileDemand;
}

export interface FileProposedStep {
  name: string;
  kind?: string;
  role?: string;
}

/** A proposed issue, or a solution idea for an issue you already track. Neither is created until a person accepts it. */
export interface FileProposal extends Backing {
  type: "issue" | "solution_idea";
  title: string;
  detail?: string;
  /** Issues: great, good, bad or risk (default good). */
  rating?: (typeof RATINGS)[number];
  issue_type?: (typeof ISSUE_TYPES)[number];
  /** Step ids of this process it touches (issues). Without any it touches the whole process. */
  steps?: string[];
  target_measure?: string;
  target_now?: string;
  target_goal?: string;
  /** Solution ideas: the issue it is for, by number (12 or "#12") or title. The issue must exist already. */
  for_issue?: string;
  proposed_steps?: FileProposedStep[];
  expect?: string;
}

export interface FileFirstPrinciples {
  job?: Backing & { who?: string; progress?: string; situation?: string; done?: string };
  truths: (Backing & { text: string; kind?: (typeof FP_KINDS)[number]; test?: string })[];
  requirements: (Backing & { text: string; owner?: string; why?: string; verdict?: (typeof FP_VERDICTS)[number]; step?: string })[];
  measures: (Backing & { text: string; kpi?: (typeof SUCCESS_KPI_KEYS)[number]; comparator?: (typeof FP_COMPARATORS)[number]; target?: number; horizon?: string })[];
  why?: Backing & { problem?: string; chain?: string[]; root?: string };
}

/** What the v2 checker needs from the file's steps. */
export interface StepsView {
  ids: readonly string[];
  has: (id: string) => boolean;
  name: (id: string) => string;
}

/** The place the checkers write problems to, and the sources they check references against. */
export interface Env {
  errors: string[];
  warnings: string[];
  conflicts: string[];
  sources: FileSource[];
  budget: { left: number };
}

const text = (v: unknown, max: number, where: string, what: string, env: Env): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    env.errors.push(`${where}: ${what} should be text.`);
    return undefined;
  }
  if (v.length > max) env.errors.push(`${where}: ${what} is ${v.length} characters long; the most is ${max}.`);
  return v.trim() || undefined;
};

const number = (v: unknown, where: string, what: string, min: number, max: number, env: Env, hint = ""): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    env.errors.push(`${where}: ${what} should be a number${hint ? ` (${hint})` : ""}.`);
    return undefined;
  }
  if (v < min || v > max) {
    env.errors.push(`${where}: ${what} is ${v}, but it has to be between ${min} and ${max}${hint ? ` (${hint})` : ""}.`);
    return undefined;
  }
  return v;
};

const strings = (v: unknown, where: string, what: string, max: number, env: Env): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    env.errors.push(`${where}: ${what} should be a list of names.`);
    return undefined;
  }
  if (v.length > max) env.errors.push(`${where}: ${what} lists ${v.length}; the most is ${max}.`);
  return v.slice(0, max).map((x) => (x as string).trim()).filter(Boolean);
};

const unknownFields = (raw: Record<string, unknown>, known: readonly string[], where: string, env: Env) => {
  for (const key of Object.keys(raw)) if (!known.includes(key)) env.warnings.push(`${where} has a field ${q(key)} that Transpera doesn't use. It was ignored.`);
};

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const SOURCE_FIELDS = ["id", "title", "kind", "date", "speakers", "body"];

/** The file's `sources`: what each is, who spoke in it and when. Returned in file order. */
export function checkSources(raw: unknown, env: Env): FileSource[] {
  const out: FileSource[] = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) {
    env.errors.push('"sources" should be a list of {id, title, kind, date, speakers} entries.');
    return out;
  }
  if (raw.length > MAX_FILE_SOURCES) env.errors.push(`The file has ${raw.length} sources; the most Transpera takes in one upload is ${MAX_FILE_SOURCES}.`);
  const seen = new Set<string>();
  raw.slice(0, MAX_FILE_SOURCES).forEach((s, i) => {
    const where = `Source ${i + 1}`;
    if (!isObject(s)) return void env.errors.push(`${where} should be an object with an id and a title.`);
    const id = typeof s.id === "string" ? s.id.trim() : typeof s.id === "number" ? String(s.id) : "";
    const title = typeof s.title === "string" ? s.title.trim() : "";
    const label = title ? `Source ${q(title)}` : id ? `Source ${q(id)}` : where;
    if (!id) env.errors.push(`${label} has no id. Give each source a short id (like "interview-maya") so evidence can point at it.`);
    else if (id.length > 64) env.errors.push(`${label}'s id is ${id.length} characters long; ids are short labels (the most is 64).`);
    if (!title) env.errors.push(`${label} has no title.`);
    else if (title.length > 200) env.errors.push(`${label}'s title is ${title.length} characters long; the most is 200.`);
    unknownFields(s, SOURCE_FIELDS, label, env);
    let kind: FileSourceKind = "transcript";
    if (s.kind !== undefined) {
      if (typeof s.kind === "string" && (SOURCE_KINDS as readonly string[]).includes(s.kind)) kind = s.kind as FileSourceKind;
      else env.errors.push(`${label} has the kind ${typeof s.kind === "string" ? q(s.kind) : "given"}, which Transpera doesn't know. Use transcript, notes, data or screenshot.`);
    }
    let date: string | undefined;
    if (s.date !== undefined && s.date !== null) {
      if (typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date) && !Number.isNaN(Date.parse(s.date)) && new Date(s.date).toISOString().startsWith(s.date)) date = s.date;
      else env.errors.push(`${label}: the date should be a day like 2026-09-30.`);
    }
    const speakers = strings(s.speakers, label, "speakers", 50, env) ?? [];
    if (speakers.some((x) => x.length > 200)) env.errors.push(`${label}: a speaker's name is longer than 200 characters.`);
    const body = text(s.body, MAX_BODY, label, "body", env);
    if (id) {
      if (seen.has(id)) env.errors.push(`Two sources have the id ${q(id)}. Every source needs its own id.`);
      seen.add(id);
    }
    if (id && title) out.push({ id, title, kind, ...(date ? { date } : {}), speakers, ...(body ? { body } : {}) });
  });
  return out;
}

/** The source a reference names: its id, or (when nothing has that id) its title. */
function sourceFor(ref: string, env: Env): FileSource | undefined {
  const byId = env.sources.find((s) => s.id === ref);
  if (byId) return byId;
  const byTitle = env.sources.filter((s) => norm(s.title) === norm(ref));
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

// ---------------------------------------------------------------------------
// Evidence and assumptions
// ---------------------------------------------------------------------------

const CITATION_FIELDS = ["source", "quote", "speaker", "time", "value"];

/** A quote as compared with a source's text: case, punctuation and spacing are ignored, so a transcript's line breaks don't matter. */
const squash = (s: string) => s.toLowerCase().replace(/[\s‘’“”"'`.,;:!?()[\]-]+/g, " ").trim();

/** The citations of one value (a list of {source, quote, speaker, time, value}). */
export function readCitations(raw: unknown, where: string, env: Env, opts: { valueMax?: number } = {}): FileCitation[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    env.errors.push(`${where}: "evidence" should be a list of quotes, each with a source and the words said.`);
    return [];
  }
  if (raw.length > MAX_CITATIONS) env.errors.push(`${where}: ${raw.length} quotes is too many for one value; the most is ${MAX_CITATIONS}.`);
  const out: FileCitation[] = [];
  raw.slice(0, MAX_CITATIONS).forEach((c, i) => {
    const at = raw.length > 1 ? `${where}, quote ${i + 1}` : where;
    if (!isObject(c)) return void env.errors.push(`${at}: each quote should be an object with a source and the words said.`);
    unknownFields(c, CITATION_FIELDS, at, env);
    const ref = typeof c.source === "string" ? c.source.trim() : "";
    const quote = typeof c.quote === "string" ? c.quote.trim() : "";
    if (!ref) env.errors.push(`${at}: a quote needs a "source" (the id of one of the file's sources).`);
    if (!quote) env.errors.push(`${at}: a quote needs the words said, word for word.`);
    else if (quote.length > MAX_QUOTE) env.errors.push(`${at}: the quote is ${quote.length} characters long; the most is ${MAX_QUOTE}. Quote just the sentence that gives the number.`);
    let source: FileSource | undefined;
    if (ref) {
      source = sourceFor(ref, env);
      if (!source) {
        const near = suggest(ref, env.sources.map((s) => s.id), env.budget);
        env.errors.push(
          env.sources.length
            ? `${at} cites the source ${q(ref)}, which isn't in the file's sources.${near ? ` Did you mean ${q(near)}?` : ""}`
            : `${at} cites the source ${q(ref)}, but the file has no "sources" list. Add the source (an id and a title) first.`,
        );
      }
    }
    const speaker = text(c.speaker, 200, at, "speaker", env);
    const time = c.time === undefined || c.time === null ? undefined : text(typeof c.time === "number" ? String(c.time) : c.time, 100, at, "time", env);
    const value = number(c.value, at, "the number stated", 0, opts.valueMax ?? 1_000_000, env);
    if (source && quote) {
      if (speaker && source.speakers.length && !source.speakers.some((s) => norm(s) === norm(speaker))) {
        env.warnings.push(`${at}: ${q(speaker)} isn't listed as a speaker of ${q(source.title)} (${source.speakers.join(", ")}).`);
      }
      if (source.body && !squash(source.body).includes(squash(quote))) {
        env.warnings.push(`${at}: the quote isn't in the text of ${q(source.title)} word for word. Check it against the source.`);
      }
      out.push({ source: source.id, quote, ...(speaker ? { speaker } : {}), ...(time ? { time } : {}), ...(value !== undefined ? { value } : {}) });
    }
  });
  return out;
}

/** The reason a value is assumed: one sentence on why it is a guess and where it comes from. */
export function readAssumed(raw: unknown, where: string, env: Env): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    env.errors.push(`${where}: "assumed" should be a sentence saying why the value is an assumption.`);
    return undefined;
  }
  if (raw.length > MAX_REASON) env.errors.push(`${where}: the assumed reason is ${raw.length} characters long; the most is ${MAX_REASON}.`);
  return raw.trim();
}

/** `evidence` and `assumed` of an item (company, proposal, first principles). */
export function readBacking(raw: Record<string, unknown>, where: string, env: Env, opts: { warnIfBare?: boolean } = {}): Backing {
  const evidence = readCitations(raw.evidence, where, env);
  const assumed = readAssumed(raw.assumed, where, env);
  if (opts.warnIfBare && !evidence.length && assumed === undefined && raw.evidence === undefined) {
    env.warnings.push(`${where} has neither evidence nor an assumed reason, so whoever reviews it won't see where it came from.`);
  }
  return { evidence, ...(assumed ? { assumed } : {}) };
}

/** Step values that have more than one stated number are a conflict: say so, with who said what. */
export function citationConflict(label: string, field: EvidenceField, cites: readonly FileCitation[], env: Env): void {
  const stated = cites.filter((c) => c.value !== undefined);
  const values = new Set(stated.map((c) => c.value));
  if (values.size < 2) return;
  const said = stated.map((c) => `${env.sources.find((s) => s.id === c.source)?.title ?? c.source}${c.speaker ? ` (${c.speaker})` : ""}: ${c.value}`).join("; ");
  env.conflicts.push(`${label}: the sources disagree on ${EVIDENCE_FIELD_WORDS[field]} (${said}). Both are kept and flagged on the draft for you to settle.`);
}

// ---------------------------------------------------------------------------
// What /2 adds to a step
// ---------------------------------------------------------------------------

/** The step fields /2 reads on top of /1's. */
export const STEP_FIELDS_2 = ["hands_on_range", "wait_range", "rework_to", "tool", "sla_hours", "waiting_now", "evidence", "assumed"];

export interface StepExtras {
  hands_on_range?: FileRange;
  wait_range?: FileRange;
  rework_to?: string;
  tool?: string;
  sla_hours?: number;
  waiting_now?: number;
  evidence?: Partial<Record<EvidenceField, FileCitation[]>>;
  assumed?: Partial<Record<EvidenceField, string>>;
}

/** The numbers /1 already read for the step (hours, wait, rework), which the new fields are checked against. */
export interface GivenNumbers {
  hands_on_hours?: number;
  wait_hours?: number;
  rework_rate?: number;
}

function readRange(v: unknown, label: string, what: string, max: number, given: number | undefined, env: Env): FileRange | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v) || typeof v.min !== "number" || typeof v.max !== "number" || !Number.isFinite(v.min) || !Number.isFinite(v.max)) {
    env.errors.push(`${label}: ${what} should be {"min": number, "max": number}, the lowest and highest hours.`);
    return undefined;
  }
  unknownFields(v, ["min", "max"], `${label}, ${what}`, env);
  if (v.min < 0 || v.max > max || v.min > v.max) {
    env.errors.push(`${label}: ${what} is ${v.min} to ${v.max}, but it has to run from the lowest to the highest hours, between 0 and ${max}.`);
    return undefined;
  }
  if (given !== undefined && (given < v.min || given > v.max)) {
    env.errors.push(`${label}: ${what} is ${v.min} to ${v.max}, but the typical value ${given} is outside it.`);
    return undefined;
  }
  return { min: v.min, max: v.max };
}

/** What /2 adds to a step: ranges, where rework goes, the tool, the SLA, items waiting now, and the evidence for each value. */
export function readStepExtras(raw: Record<string, unknown>, label: string, env: Env, given: GivenNumbers): StepExtras {
  const out: StepExtras = {};
  const hands = readRange(raw.hands_on_range, label, "hands_on_range", 10_000, given.hands_on_hours, env);
  if (hands) out.hands_on_range = hands;
  const wait = readRange(raw.wait_range, label, "wait_range", 100_000, given.wait_hours, env);
  if (wait) out.wait_range = wait;
  if (raw.rework_to !== undefined && raw.rework_to !== null) {
    if (typeof raw.rework_to === "string" && raw.rework_to.trim()) out.rework_to = raw.rework_to.trim();
    else env.errors.push(`${label}: rework_to should be the id of the step rework goes back to.`);
  }
  const tool = text(raw.tool, 200, label, "tool", env);
  if (tool) out.tool = tool;
  const sla = number(raw.sla_hours, label, "sla_hours", 0, 10_000, env, "hours");
  if (sla !== undefined) out.sla_hours = sla;
  const now = number(raw.waiting_now, label, "waiting_now", 0, 1_000_000, env, "how many items sit here now");
  if (now !== undefined) {
    if (!Number.isInteger(now)) env.errors.push(`${label}: waiting_now should be a whole number of items.`);
    else out.waiting_now = now;
  }

  const stated: Record<EvidenceField, number | undefined> = {
    hands_on_hours: given.hands_on_hours,
    wait_hours: given.wait_hours,
    rework_rate: given.rework_rate,
    waiting_now: out.waiting_now,
    sla_hours: out.sla_hours,
  };
  if (raw.evidence !== undefined && raw.evidence !== null) {
    if (!isObject(raw.evidence)) env.errors.push(`${label}: "evidence" should be an object with a list of quotes for each value, like {"hands_on_hours": [{"source": ..., "quote": ...}]}.`);
    else {
      const evidence: NonNullable<StepExtras["evidence"]> = {};
      for (const [key, v] of Object.entries(raw.evidence)) {
        if (!(EVIDENCE_FIELDS as readonly string[]).includes(key)) {
          env.warnings.push(`${label} has evidence for ${q(key)}, which Transpera doesn't take evidence for (it takes ${EVIDENCE_FIELDS.join(", ")}). It was ignored.`);
          continue;
        }
        const field = key as EvidenceField;
        const cites = readCitations(v, `${label}, ${EVIDENCE_FIELD_WORDS[field]}`, env, { valueMax: field === "rework_rate" ? 1 : 1_000_000 });
        if (!cites.length) continue;
        evidence[field] = cites;
        if (stated[field] === undefined && !cites.some((c) => c.value !== undefined)) {
          env.warnings.push(`${label}: there are quotes for ${EVIDENCE_FIELD_WORDS[field]} but no number, here or in the quotes. Give the number (or each quote's "value") so it can be used.`);
        }
        citationConflict(label, field, cites, env);
      }
      if (Object.keys(evidence).length) out.evidence = evidence;
    }
  }
  if (raw.assumed !== undefined && raw.assumed !== null) {
    if (!isObject(raw.assumed)) env.errors.push(`${label}: "assumed" should be an object with a reason for each value, like {"wait_hours": "Nobody said; typical for a proposal"}.`);
    else {
      const assumed: NonNullable<StepExtras["assumed"]> = {};
      for (const [key, v] of Object.entries(raw.assumed)) {
        if (!(EVIDENCE_FIELDS as readonly string[]).includes(key)) {
          env.warnings.push(`${label} has an assumed reason for ${q(key)}, which Transpera doesn't take one for (it takes ${EVIDENCE_FIELDS.join(", ")}). It was ignored.`);
          continue;
        }
        const reason = readAssumed(v, `${label}, ${EVIDENCE_FIELD_WORDS[key as EvidenceField]}`, env);
        if (!reason) continue;
        assumed[key as EvidenceField] = reason;
        const f = key as EvidenceField;
        const range = f === "hands_on_hours" ? out.hands_on_range : f === "wait_hours" ? out.wait_range : undefined;
        if (stated[f] === undefined && !range && !out.evidence?.[f]?.some((c) => c.value !== undefined)) {
          env.warnings.push(`${label}: there is a reason for assuming ${EVIDENCE_FIELD_WORDS[f]} but no number. Give the number you are assuming, or leave both out.`);
        }
      }
      if (Object.keys(assumed).length) out.assumed = assumed;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

const ITEM_FIELDS = ["evidence", "assumed"];

function list(raw: unknown, key: string, max: number, env: Env): unknown[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    env.errors.push(`company.${key} should be a list.`);
    return [];
  }
  if (raw.length > max) env.errors.push(`company.${key} lists ${raw.length}; the most in one file is ${max}.`);
  return raw.slice(0, max);
}

function named(raw: unknown, key: string, i: number, env: Env): { item: Record<string, unknown>; name: string; where: string } | null {
  if (!isObject(raw)) {
    env.errors.push(`company.${key} item ${i + 1} should be an object with a name.`);
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const where = name ? `company.${key} ${q(name)}` : `company.${key} item ${i + 1}`;
  if (!name) {
    env.errors.push(`${where} has no name.`);
    return null;
  }
  if (name.length > 200) {
    env.errors.push(`${where}'s name is ${name.length} characters long; the most is 200.`);
    return null;
  }
  return { item: raw, name, where };
}

const dayOf = (v: unknown, where: string, what: string, env: Env): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v).toISOString().startsWith(v)) return v;
  env.errors.push(`${where}: ${what} should be a day like 2026-09-30.`);
  return undefined;
};

const COMPANY_KEYS = ["people", "roles", "clients", "services", "demand"];
const PERSON_FIELDS = ["name", "roles", "fte", "hours_per_week", "cost_rate", "email", "start_date", "leave", ...ITEM_FIELDS];
const ROLE_FIELDS = ["name", ...ITEM_FIELDS];
const CLIENT_FIELDS = ["name", "services", "mrr", "start_date", "health", "notes", "active", "assignments", ...ITEM_FIELDS];
const SERVICE_FIELDS = ["name", "pricing_model", "price", "margin", "tenure_months", "monthly_churn", "mix_share", ...ITEM_FIELDS];
const DEMAND_FIELDS = ["lead_sources", "growth_monthly", "seasonality", ...ITEM_FIELDS];
const LEAD_FIELDS = ["name", "volume_per_week", "conversion_to_qualified", ...ITEM_FIELDS];

/** The file's `company`: people, roles, clients, services and demand. */
export function checkCompany(raw: unknown, env: Env): FileCompany | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    env.errors.push('"company" should be an object with people, roles, clients, services and demand.');
    return undefined;
  }
  unknownFields(raw, COMPANY_KEYS, "The company section", env);
  const company: FileCompany = { people: [], roles: [], clients: [], services: [] };

  list(raw.people, "people", MAX_COMPANY_ITEMS, env).forEach((r, i) => {
    const n = named(r, "people", i, env);
    if (!n) return;
    const { item, name, where } = n;
    unknownFields(item, PERSON_FIELDS, where, env);
    const person: FilePerson = { name, ...readBacking(item, where, env, { warnIfBare: true }) };
    const roles = strings(item.roles, where, "roles", 20, env);
    if (roles) person.roles = roles;
    const fte = number(item.fte, where, "fte", 0.01, 1.5, env, "1 is full time");
    if (fte !== undefined) person.fte = fte;
    const hours = number(item.hours_per_week, where, "hours_per_week", 0.5, 168, env);
    if (hours !== undefined) person.hours_per_week = hours;
    const rate = number(item.cost_rate, where, "cost_rate", 0, 100_000, env, "the hourly cost");
    if (rate !== undefined) person.cost_rate = rate;
    const email = text(item.email, 320, where, "email", env);
    if (email) person.email = email;
    const start = dayOf(item.start_date, where, "start_date", env);
    if (start) person.start_date = start;
    if (item.leave !== undefined && item.leave !== null) {
      if (!Array.isArray(item.leave) || item.leave.length > 50) env.errors.push(`${where}: leave should be a list of {"start_date", "end_date"} days, like 2026-12-07.`);
      else {
        const leave: NonNullable<FilePerson["leave"]> = [];
        item.leave.forEach((l, j) => {
          if (!isObject(l)) return void env.errors.push(`${where}: leave ${j + 1} should be an object with a start_date and an end_date.`);
          unknownFields(l, ["start_date", "end_date", "note"], `${where}, leave ${j + 1}`, env);
          const from = dayOf(l.start_date, where, `leave ${j + 1} start_date`, env);
          const to = dayOf(l.end_date, where, `leave ${j + 1} end_date`, env);
          if (l.start_date === undefined || l.end_date === undefined) return void env.errors.push(`${where}: leave ${j + 1} needs a start_date and an end_date.`);
          if (!from || !to) return;
          if (to < from) return void env.errors.push(`${where}: leave ${j + 1} ends (${to}) before it starts (${from}).`);
          const note = text(l.note, 500, where, "a leave note", env);
          leave.push({ start_date: from, end_date: to, ...(note ? { note } : {}) });
        });
        if (leave.length) person.leave = leave;
      }
    }
    company.people.push(person);
  });

  list(raw.roles, "roles", MAX_COMPANY_ITEMS, env).forEach((r, i) => {
    const n = named(r, "roles", i, env);
    if (!n) return;
    unknownFields(n.item, ROLE_FIELDS, n.where, env);
    company.roles.push({ name: n.name, ...readBacking(n.item, n.where, env, { warnIfBare: true }) });
  });

  list(raw.clients, "clients", MAX_COMPANY_ITEMS, env).forEach((r, i) => {
    const n = named(r, "clients", i, env);
    if (!n) return;
    const { item, name, where } = n;
    unknownFields(item, CLIENT_FIELDS, where, env);
    const client: FileClient = { name, ...readBacking(item, where, env, { warnIfBare: true }) };
    const services = strings(item.services, where, "services", 20, env);
    if (services) client.services = services;
    const mrr = number(item.mrr, where, "mrr", 0, 1e9, env, "monthly recurring revenue");
    if (mrr !== undefined) client.mrr = mrr;
    const start = dayOf(item.start_date, where, "start_date", env);
    if (start) client.start_date = start;
    const health = number(item.health, where, "health", 0, 100, env, "0 to 100");
    if (health !== undefined) client.health = health;
    const notes = text(item.notes, MAX_TEXT, where, "notes", env);
    if (notes) client.notes = notes;
    if (item.active !== undefined && item.active !== null) {
      if (typeof item.active === "boolean") client.active = item.active;
      else env.errors.push(`${where}: active should be true or false.`);
    }
    if (item.assignments !== undefined && item.assignments !== null) {
      if (!isObject(item.assignments) || Object.values(item.assignments).some((v) => typeof v !== "string" || !v.trim())) {
        env.errors.push(`${where}: assignments should be a role and a person, like {"Account director": "Tom Whitfield"}.`);
      } else if (Object.keys(item.assignments).length) client.assignments = Object.fromEntries(Object.entries(item.assignments).map(([k, v]) => [k.trim(), (v as string).trim()]));
    }
    company.clients.push(client);
  });

  list(raw.services, "services", MAX_COMPANY_ITEMS, env).forEach((r, i) => {
    const n = named(r, "services", i, env);
    if (!n) return;
    const { item, name, where } = n;
    unknownFields(item, SERVICE_FIELDS, where, env);
    const service: FileService = { name, ...readBacking(item, where, env, { warnIfBare: true }) };
    if (item.pricing_model !== undefined) {
      if (item.pricing_model === "retainer" || item.pricing_model === "one_off" || item.pricing_model === "hourly") service.pricing_model = item.pricing_model;
      else env.errors.push(`${where}: pricing_model should be retainer, one_off or hourly.`);
    }
    for (const [key, min, max, hint] of [
      ["price", 0, 1e9, "the monthly fee, the whole fee or the hourly rate"],
      ["margin", 0, 1, "a share from 0 to 1"],
      ["tenure_months", 0, 1200, ""],
      ["monthly_churn", 0, 1, "a share from 0 to 1, 0.02 is 2% a month"],
      ["mix_share", 0, 1e6, "the relative share of new work"],
    ] as const) {
      const v = number(item[key], where, key, min, max, env, hint);
      if (v !== undefined) service[key] = v;
    }
    company.services.push(service);
  });

  if (raw.demand !== undefined) {
    if (!isObject(raw.demand)) env.errors.push('company.demand should be an object with "lead_sources", and optionally "growth_monthly" and "seasonality".');
    else {
      const d = raw.demand;
      const where = "company.demand";
      unknownFields(d, DEMAND_FIELDS, where, env);
      const demand: FileDemand = { lead_sources: [], ...readBacking(d, where, env) };
      list(d.lead_sources, "demand.lead_sources", MAX_COMPANY_ITEMS, env).forEach((r, i) => {
        const n = named(r, "demand.lead_sources", i, env);
        if (!n) return;
        const { item, name, where: w } = n;
        unknownFields(item, LEAD_FIELDS, w, env);
        const lead: FileLeadSource = { name, ...readBacking(item, w, env, { warnIfBare: !demand.evidence.length && demand.assumed === undefined }) };
        const vol = number(item.volume_per_week, w, "volume_per_week", 0, 1e7, env, "leads a week");
        if (vol !== undefined) lead.volume_per_week = vol;
        const conv = number(item.conversion_to_qualified, w, "conversion_to_qualified", 0, 1, env, "a share from 0 to 1");
        if (conv !== undefined) lead.conversion_to_qualified = conv;
        demand.lead_sources.push(lead);
      });
      const growth = number(d.growth_monthly, where, "growth_monthly", -0.99, 10, env, "0.02 is +2% a month");
      if (growth !== undefined) demand.growth_monthly = growth;
      if (d.seasonality !== undefined) {
        if (Array.isArray(d.seasonality) && d.seasonality.length === 12 && d.seasonality.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100)) demand.seasonality = d.seasonality as number[];
        else env.errors.push(`${where}: seasonality should be twelve multipliers, January first (1 means no effect).`);
      }
      company.demand = demand;
    }
  }

  const total =
    company.people.length + company.roles.length + company.clients.length + company.services.length + (company.demand ? company.demand.lead_sources.length + (company.demand.growth_monthly !== undefined ? 1 : 0) + (company.demand.seasonality ? 12 : 0) : 0);
  if (total > MAX_FILE_SUGGESTIONS) env.errors.push(`The company section would make ${total} suggestions; the most in one file is ${MAX_FILE_SUGGESTIONS}.`);
  return company;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

const PROPOSAL_FIELDS = ["type", "title", "detail", "rating", "issue_type", "steps", "target_measure", "target_now", "target_goal", "for_issue", "proposed_steps", ...ITEM_FIELDS];
const PROPOSED_STEP_FIELDS = ["name", "kind", "role"];

/** The file's `proposals`: issues and solution ideas found in the materials. */
export function checkProposals(raw: unknown, steps: StepsView, env: Env): FileProposal[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    env.errors.push('"proposals" should be a list of proposed issues and ideas.');
    return [];
  }
  if (raw.length > MAX_PROPOSALS) env.errors.push(`The file has ${raw.length} proposals; the most in one file is ${MAX_PROPOSALS}.`);
  const out: FileProposal[] = [];
  const titles = new Set<string>();
  const stepRefs = (v: unknown, where: string, what: string): string[] | undefined => {
    const refs = strings(v, where, what, 30, env);
    if (!refs) return undefined;
    const ok: string[] = [];
    for (const r of refs) {
      if (steps.has(r)) ok.push(r);
      else {
        const near = suggest(r, steps.ids, env.budget);
        env.errors.push(`${where} lists ${q(r)} in ${what}, which isn't a step.${near ? ` Did you mean ${q(near)}?` : ""}`);
      }
    }
    return ok;
  };
  raw.slice(0, MAX_PROPOSALS).forEach((r, i) => {
    if (!isObject(r)) return void env.errors.push(`Proposal ${i + 1} should be an object with a type and a title.`);
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const where = title ? `Proposal ${q(title)}` : `Proposal ${i + 1}`;
    if (!title) return void env.errors.push(`${where} has no title.`);
    if (title.length > 200) return void env.errors.push(`${where}'s title is ${title.length} characters long; the most is 200.`);
    unknownFields(r, PROPOSAL_FIELDS, where, env);
    if (r.type !== "issue" && r.type !== "solution_idea") return void env.errors.push(`${where} has the type ${typeof r.type === "string" ? q(r.type) : "missing"}. Use "issue" (a problem worth tracking) or "solution_idea" (an idea for an issue you already track).`);
    const key = `${r.type}|${norm(title)}`;
    if (titles.has(key)) env.warnings.push(`${where} appears twice. Both are kept.`);
    titles.add(key);
    const p: FileProposal = { type: r.type, title, ...readBacking(r, where, env, { warnIfBare: true }) };
    const detail = text(r.detail, 5000, where, "detail", env);
    if (detail) p.detail = detail;
    if (r.type === "issue") {
      if (r.rating !== undefined) {
        if (typeof r.rating === "string" && (RATINGS as readonly string[]).includes(r.rating)) p.rating = r.rating as FileProposal["rating"];
        else env.errors.push(`${where}: rating should be great, good, bad or risk.`);
      }
      if (r.issue_type !== undefined) {
        if (typeof r.issue_type === "string" && (ISSUE_TYPES as readonly string[]).includes(r.issue_type)) p.issue_type = r.issue_type as FileProposal["issue_type"];
        else env.errors.push(`${where}: issue_type should be one of ${ISSUE_TYPES.join(", ")}.`);
      }
      const touched = stepRefs(r.steps, where, "steps");
      if (touched?.length) p.steps = touched;
      for (const k of ["target_measure", "target_now", "target_goal"] as const) {
        const v = text(r[k], 200, where, k, env);
        if (v) p[k] = v;
      }
      for (const k of ["for_issue", "proposed_steps", "expect"]) if (r[k] !== undefined) env.warnings.push(`${where} is an issue, so its ${q(k)} was ignored.`);
    } else {
      const forIssue = typeof r.for_issue === "number" ? String(r.for_issue) : typeof r.for_issue === "string" ? r.for_issue.trim() : "";
      if (!forIssue) env.errors.push(`${where} is a solution idea, so it needs "for_issue": the number (like 12) or title of an issue you already track.`);
      else p.for_issue = forIssue;
      if (!Array.isArray(r.proposed_steps) || !r.proposed_steps.length) env.errors.push(`${where} is a solution idea, so it needs "proposed_steps": the steps it would put in place, in order.`);
      else {
        if (r.proposed_steps.length > 30) env.errors.push(`${where} has ${r.proposed_steps.length} proposed steps; the most is 30.`);
        p.proposed_steps = [];
        r.proposed_steps.slice(0, 30).forEach((s, j) => {
          if (!isObject(s) || typeof s.name !== "string" || !s.name.trim()) return void env.errors.push(`${where}: proposed step ${j + 1} needs a name.`);
          unknownFields(s, PROPOSED_STEP_FIELDS, `${where}, proposed step ${q(s.name)}`, env);
          const step: FileProposedStep = { name: s.name.trim().slice(0, 200) };
          const kind = text(s.kind, 40, where, "a proposed step's kind", env);
          const role = text(s.role, 200, where, "a proposed step's role", env);
          if (kind) step.kind = kind;
          if (role) step.role = role;
          p.proposed_steps!.push(step);
        });
      }
      const expect = text(r.expect, 1000, where, "expect", env);
      if (expect) p.expect = expect;
      for (const k of ["rating", "issue_type", "steps", "target_measure", "target_now", "target_goal"]) if (r[k] !== undefined) env.warnings.push(`${where} is a solution idea, so its ${q(k)} was ignored.`);
    }
    out.push(p);
  });
  return out;
}

// ---------------------------------------------------------------------------
// First principles
// ---------------------------------------------------------------------------

const FP_KEYS = ["job", "truths", "requirements", "measures", "why"];

/** The file's `first_principles`: filled only where the materials say so. */
export function checkFirstPrinciples(raw: unknown, steps: StepsView, env: Env): FileFirstPrinciples | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    env.errors.push('"first_principles" should be an object with job, truths, requirements, measures and why.');
    return undefined;
  }
  unknownFields(raw, FP_KEYS, "first_principles", env);
  const fp: FileFirstPrinciples = { truths: [], requirements: [], measures: [] };
  const items = (v: unknown, key: string): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      env.errors.push(`first_principles.${key} should be a list.`);
      return [];
    }
    if (v.length > FP_MAX_ITEMS) env.errors.push(`first_principles.${key} lists ${v.length}; the most is ${FP_MAX_ITEMS}.`);
    return v.slice(0, FP_MAX_ITEMS);
  };

  if (raw.job !== undefined) {
    if (!isObject(raw.job)) env.errors.push("first_principles.job should be an object with who, progress, situation and done.");
    else {
      const j = raw.job;
      unknownFields(j, ["who", "progress", "situation", "done", ...ITEM_FIELDS], "first_principles.job", env);
      const job: NonNullable<FileFirstPrinciples["job"]> = { ...readBacking(j, "first_principles.job", env, { warnIfBare: true }) };
      for (const k of ["who", "progress", "situation", "done"] as const) {
        const v = text(j[k], MAX_TEXT, "first_principles.job", k, env);
        if (v) job[k] = v;
      }
      fp.job = job;
    }
  }

  items(raw.truths, "truths").forEach((r, i) => {
    const where = `first_principles.truths item ${i + 1}`;
    if (!isObject(r)) return void env.errors.push(`${where} should be an object with text.`);
    const t = text(r.text, MAX_TEXT, where, "text", env);
    if (!t) return void env.errors.push(`${where} has no text.`);
    unknownFields(r, ["text", "kind", "test", ...ITEM_FIELDS], where, env);
    const item: FileFirstPrinciples["truths"][number] = { text: t, ...readBacking(r, `${where} ${q(t.slice(0, 40))}`, env, { warnIfBare: true }) };
    if (r.kind !== undefined) {
      if (typeof r.kind === "string" && (FP_KINDS as readonly string[]).includes(r.kind)) item.kind = r.kind as (typeof FP_KINDS)[number];
      else env.errors.push(`${where}: kind should be truth or assumption.`);
    }
    const test = text(r.test, MAX_TEXT, where, "test", env);
    if (test) item.test = test;
    fp.truths.push(item);
  });

  const ref = (v: unknown, where: string): string | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string" || !steps.has(v.trim())) {
      const near = typeof v === "string" ? suggest(v.trim(), steps.ids, env.budget) : null;
      env.errors.push(`${where} names ${typeof v === "string" ? q(v) : "something"} as its step, which isn't a step.${near ? ` Did you mean ${q(near)}?` : ""}`);
      return undefined;
    }
    return v.trim();
  };
  items(raw.requirements, "requirements").forEach((r, i) => {
    const where = `first_principles.requirements item ${i + 1}`;
    if (!isObject(r)) return void env.errors.push(`${where} should be an object with text.`);
    const t = text(r.text, MAX_TEXT, where, "text", env);
    if (!t) return void env.errors.push(`${where} has no text.`);
    unknownFields(r, ["text", "owner", "why", "verdict", "step", ...ITEM_FIELDS], where, env);
    const item: FileFirstPrinciples["requirements"][number] = { text: t, ...readBacking(r, `${where} ${q(t.slice(0, 40))}`, env, { warnIfBare: true }) };
    const owner = text(r.owner, 200, where, "owner", env);
    if (owner) item.owner = owner;
    const why = text(r.why, MAX_TEXT, where, "why", env);
    if (why) item.why = why;
    if (r.verdict !== undefined) {
      if (typeof r.verdict === "string" && (FP_VERDICTS as readonly string[]).includes(r.verdict)) item.verdict = r.verdict as (typeof FP_VERDICTS)[number];
      else env.errors.push(`${where}: verdict should be keep, change, drop or challenge.`);
    }
    const step = ref(r.step, where);
    if (step) item.step = step;
    fp.requirements.push(item);
  });

  items(raw.measures, "measures").forEach((r, i) => {
    const where = `first_principles.measures item ${i + 1}`;
    if (!isObject(r)) return void env.errors.push(`${where} should be an object with text.`);
    const t = text(r.text, MAX_TEXT, where, "text", env);
    if (!t) return void env.errors.push(`${where} has no text.`);
    unknownFields(r, ["text", "kpi", "comparator", "target", "horizon", ...ITEM_FIELDS], where, env);
    const item: FileFirstPrinciples["measures"][number] = { text: t, ...readBacking(r, `${where} ${q(t.slice(0, 40))}`, env, { warnIfBare: true }) };
    if (r.kpi !== undefined && r.kpi !== null) {
      if (typeof r.kpi === "string" && (SUCCESS_KPI_KEYS as readonly string[]).includes(r.kpi)) item.kpi = r.kpi as (typeof SUCCESS_KPI_KEYS)[number];
      else env.errors.push(`${where}: kpi should be one of ${SUCCESS_KPI_KEYS.join(", ")}, or left out.`);
    }
    if (r.comparator !== undefined) {
      if (typeof r.comparator === "string" && (FP_COMPARATORS as readonly string[]).includes(r.comparator)) item.comparator = r.comparator as (typeof FP_COMPARATORS)[number];
      else env.errors.push(`${where}: comparator should be atLeast or atMost.`);
    }
    const target = number(r.target, where, "target", -1e12, 1e12, env, "in the unit people read: a win rate of 30% is 30");
    if (target !== undefined) item.target = target;
    const horizon = text(r.horizon, 200, where, "horizon", env);
    if (horizon) item.horizon = horizon;
    fp.measures.push(item);
  });

  if (raw.why !== undefined) {
    if (!isObject(raw.why)) env.errors.push("first_principles.why should be an object with problem, chain and root.");
    else {
      const w = raw.why;
      unknownFields(w, ["problem", "chain", "root", ...ITEM_FIELDS], "first_principles.why", env);
      const why: NonNullable<FileFirstPrinciples["why"]> = { ...readBacking(w, "first_principles.why", env, { warnIfBare: true }) };
      const problem = text(w.problem, MAX_TEXT, "first_principles.why", "problem", env);
      if (problem) why.problem = problem;
      const root = text(w.root, MAX_TEXT, "first_principles.why", "root", env);
      if (root) why.root = root;
      const chain = strings(w.chain, "first_principles.why", "chain", FP_MAX_CHAIN, env);
      if (chain?.length) why.chain = chain;
      fp.why = why;
    }
  }
  return fp;
}

/** How many things each v2 section will make, for the preview and for tests. */
export function sectionCounts(file: {
  sources?: readonly FileSource[];
  company?: FileCompany;
  proposals?: readonly FileProposal[];
  first_principles?: FileFirstPrinciples;
}): { sources: number; company: number; proposals: number; firstPrinciples: number } {
  const c = file.company;
  const company = c ? c.people.length + c.roles.length + c.clients.length + c.services.length + (c.demand ? c.demand.lead_sources.length + (c.demand.growth_monthly !== undefined ? 1 : 0) + (c.demand.seasonality ? 1 : 0) : 0) : 0;
  const f = file.first_principles;
  const firstPrinciples = f ? (f.job ? 1 : 0) + f.truths.length + f.requirements.length + f.measures.length + (f.why ? 1 : 0) : 0;
  return { sources: file.sources?.length ?? 0, company, proposals: file.proposals?.length ?? 0, firstPrinciples };
}

