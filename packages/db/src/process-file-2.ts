// What `transpera-process/2` adds to the /1 file (issue #167, B14): evidence for every number and a list of sources.
// (It used to carry facts about the company, proposed issues and ideas, and first principles as well; they are gone,
// and a file that still has them gets a warning that they are not read.) The steps, links and groups are checked in process-file.ts
// (shared with /1); this module checks the new parts and holds their types, schema pieces and the prompt's extra rules.
// Pure: no I/O and no framework.
//
// A file never changes anything live: sources are added and linked to the process.

// The engine's lists (ratings, issue types) are written out here, not imported: this
// module and the schema generator (scripts/gen-import-schema.ts) run under plain Node, which can't load the engine's source. A
// test (process-file-2.test.ts) fails if any list drifts from the engine's.

import { isObject, norm, q, suggest } from "@transpera-flow/db/process-file-util";

export const PROCESS_FILE_FORMAT_2 = "transpera-process/2";


export const SOURCE_KINDS = ["transcript", "notes", "sop", "spreadsheet", "data", "screenshot", "other"] as const;
export type FileSourceKind = (typeof SOURCE_KINDS)[number];

export const MAX_FILE_SOURCES = 50;
const MAX_QUOTE = 2000;
const MAX_CITATIONS = 10;
const MAX_REASON = 2000;
const MAX_BODY = 500_000;

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
      else env.errors.push(`${label} has the kind ${typeof s.kind === "string" ? q(s.kind) : "given"}, which Transpera doesn't know. Use transcript, notes, sop, spreadsheet, data, screenshot or other.`);
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

/** `evidence` and `assumed` of an item (a source's own items). */
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
export const STEP_FIELDS_2 = [
  "hands_on_range", "wait_range", "rework_to", "tool", "sla_hours", "waiting_now", "evidence", "assumed",
  "split", "split_notes", "tier_multiplier", "to_client_manager", "sources",
];

/** The parts of a step's hands-on time (capacity P4): the work of gathering, of judging, of checking. */
export const SPLIT_PARTS = ["automatable", "augmentable", "manual"] as const;
export type SplitPart = (typeof SPLIT_PARTS)[number];
/** What each part is in the interviews' words (the process-file skill's gather / judge / check). */
export const SPLIT_PART_WORDS: Record<SplitPart, string> = { automatable: "automatable (gather)", augmentable: "augmentable (judge)", manual: "manual (check)" };
/** The shares of a split must add up to 1 within this (the database checks the same). */
export const SPLIT_SUM_TOLERANCE = 0.001;
/** Where a base value came from (requirements section 7); the engine's `SourceLabel`. A test keeps the lists equal. */
export const SOURCE_LABELS = ["interview", "calculator", "measured", "estimate"] as const;
export type FileSourceLabel = (typeof SOURCE_LABELS)[number];
/** The step values that carry a source label. */
export const SOURCED_VALUES = ["work", "split", "tier_multiplier"] as const;
export type SourcedValue = (typeof SOURCED_VALUES)[number];
export const MAX_SPLIT_NOTE = 300;
export const MAX_TIER_MULTIPLIER = 100;
export const MAX_TIERS = 50;

export interface StepExtras {
  hands_on_range?: FileRange;
  wait_range?: FileRange;
  rework_to?: string;
  tool?: string;
  sla_hours?: number;
  waiting_now?: number;
  evidence?: Partial<Record<EvidenceField, FileCitation[]>>;
  assumed?: Partial<Record<EvidenceField, string>>;
  /** Shares of the step's hands-on time that can be automated, augmented or only done by hand; they add up to 1. */
  split?: Record<SplitPart, number>;
  /** One line of words for each part of the split. */
  split_notes?: Partial<Record<SplitPart, string>>;
  /** × on the step's time by tier key (a tier not listed is 1). */
  tier_multiplier?: Record<string, number>;
  /** The step goes to the client's manager, falling back to its role. */
  to_client_manager?: boolean;
  /** Where each base value came from. */
  sources?: Partial<Record<SourcedValue, FileSourceLabel>>;
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

/** The step's work split, tier multipliers, manager routing and source labels (capacity P4), with problems in plain words. */
function readBaseValues(raw: Record<string, unknown>, label: string, env: Env, out: StepExtras): void {
  if (raw.split !== undefined && raw.split !== null) {
    const sp = raw.split;
    if (!isObject(sp)) env.errors.push(`${label}: "split" should be {"automatable": 0.5, "augmentable": 0.3, "manual": 0.2}: the share of the step's time that can be automated, augmented, or only done by hand.`);
    else {
      unknownFields(sp, SPLIT_PARTS, `${label}, split`, env);
      const missing = SPLIT_PARTS.filter((p) => sp[p] === undefined || sp[p] === null);
      const bad = SPLIT_PARTS.filter((p) => !missing.includes(p) && (typeof sp[p] !== "number" || !Number.isFinite(sp[p]) || (sp[p] as number) < 0 || (sp[p] as number) > 1));
      if (missing.length) env.errors.push(`${label}: the split needs a share for ${SPLIT_PARTS.map((p) => `"${p}"`).join(", ")}; ${missing.map((p) => `"${p}"`).join(" and ")} ${missing.length === 1 ? "is" : "are"} missing. Use 0 for a part that doesn't exist.`);
      for (const p of bad) env.errors.push(`${label}: the split's ${p} share is ${typeof sp[p] === "number" ? sp[p] : "not a number"}, but a share runs from 0 to 1 (0.5 is half).`);
      if (!missing.length && !bad.length) {
        const parts = SPLIT_PARTS.map((p) => sp[p] as number);
        const total = parts.reduce((a, b) => a + b, 0);
        if (Math.abs(total - 1) > SPLIT_SUM_TOLERANCE) env.errors.push(`${label}: the split's shares add up to ${Math.round(total * 1000) / 10}%, but they must add up to 100%.`);
        else out.split = { automatable: parts[0]!, augmentable: parts[1]!, manual: parts[2]! };
      }
    }
  }
  if (raw.split_notes !== undefined && raw.split_notes !== null) {
    if (!isObject(raw.split_notes)) env.errors.push(`${label}: "split_notes" should be a line of words for each part, like {"automatable": "Pull spend and budgets"}.`);
    else {
      unknownFields(raw.split_notes, SPLIT_PARTS, `${label}, split_notes`, env);
      const notes: Partial<Record<SplitPart, string>> = {};
      for (const part of SPLIT_PARTS) {
        const v = raw.split_notes[part];
        if (v === undefined || v === null) continue;
        if (typeof v !== "string") env.errors.push(`${label}: the split note for ${part} should be text.`);
        else if (/[\r\n]/.test(v.trim())) env.errors.push(`${label}: the split note for ${part} should be one line.`);
        else if (v.trim().length > MAX_SPLIT_NOTE) env.errors.push(`${label}: the split note for ${part} is ${v.trim().length} characters long; the most is ${MAX_SPLIT_NOTE}.`);
        else if (v.trim()) notes[part] = v.trim();
      }
      if (Object.keys(notes).length) out.split_notes = notes;
      if (Object.keys(notes).length && raw.split === undefined) env.warnings.push(`${label} has split_notes but no split, so the notes won't be used until the shares are given.`);
    }
  }
  if (raw.tier_multiplier !== undefined && raw.tier_multiplier !== null) {
    const tm = raw.tier_multiplier;
    if (!isObject(tm)) env.errors.push(`${label}: "tier_multiplier" should give a number for each tier, like {"T1": 1.3, "T2": 1, "T3": 0.8}.`);
    else {
      const entries = Object.entries(tm);
      if (entries.length > MAX_TIERS) env.errors.push(`${label}: tier_multiplier lists ${entries.length} tiers; the most is ${MAX_TIERS}.`);
      const mult: Record<string, number> = {};
      for (const [tier, v] of entries.slice(0, MAX_TIERS)) {
        if (!tier.trim() || tier.trim().length > 40) env.errors.push(`${label}: a tier in tier_multiplier needs a name of 1 to 40 characters.`);
        else if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_TIER_MULTIPLIER) env.errors.push(`${label}: the multiplier for tier ${q(tier)} should be a number from 0 to ${MAX_TIER_MULTIPLIER} (1 means the base time, 1.3 means 30% longer).`);
        else mult[tier.trim()] = v;
      }
      if (Object.keys(mult).length) out.tier_multiplier = mult;
    }
  }
  if (raw.to_client_manager !== undefined && raw.to_client_manager !== null) {
    if (typeof raw.to_client_manager !== "boolean") env.errors.push(`${label}: to_client_manager should be true or false.`);
    else if (raw.to_client_manager) {
      out.to_client_manager = true;
      if (typeof raw.role !== "string" || !raw.role.trim()) env.warnings.push(`${label} goes to the client's manager but has no role, so it has no one to fall back to when a client has no manager. Give it a role.`);
    }
  }
  if (raw.sources !== undefined && raw.sources !== null) {
    if (!isObject(raw.sources)) env.errors.push(`${label}: "sources" should say where each value came from, like {"work": "interview", "split": "estimate"}.`);
    else {
      const sources: Partial<Record<SourcedValue, FileSourceLabel>> = {};
      for (const [key, v] of Object.entries(raw.sources)) {
        if (!(SOURCED_VALUES as readonly string[]).includes(key)) {
          env.warnings.push(`${label} has a source for ${q(key)}, which Transpera doesn't label (it labels ${SOURCED_VALUES.join(", ")}). It was ignored.`);
          continue;
        }
        if (typeof v !== "string" || !(SOURCE_LABELS as readonly string[]).includes(v)) {
          env.errors.push(`${label}: the source of ${key} is ${typeof v === "string" ? q(v) : "not text"}; use ${SOURCE_LABELS.join(", ")}.`);
          continue;
        }
        sources[key as SourcedValue] = v as FileSourceLabel;
      }
      if (Object.keys(sources).length) out.sources = sources;
      if (sources.split && raw.split === undefined) env.warnings.push(`${label} gives a source for the split but no split.`);
      if (sources.tier_multiplier && raw.tier_multiplier === undefined) env.warnings.push(`${label} gives a source for the tier multipliers but no tier_multiplier.`);
    }
  }
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

  readBaseValues(raw, label, env, out);

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

/** How many things each v2 section will make, for the preview and for tests. */
export function sectionCounts(file: { sources?: readonly FileSource[] }): { sources: number } {
  return { sources: file.sources?.length ?? 0 };
}

