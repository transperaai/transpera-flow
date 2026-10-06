// Who may see which person's name, and AI text saved with labels (B1 2b, issue #30; decision log: Austin, 6 Oct). Pure: no
// database, so the web app, MCP and the tests all use the one rule.
//
// AI analysis never sees a name: people are "Team member A", "Team member B" in what the model is sent. The text it writes
// is saved exactly so, with `person_labels` (label → person id) beside it. A reader gets names back at render:
//   * a reader who sees everyone (owners, editors, agency admins): the person's current name;
//   * a member or viewer: their own name for their own label, "A team member" for everyone else;
//   * a person since deleted, for anyone: "A team member".
// The map holds ids, never names, so it tells a member nothing new. The letters are the AI's own and are never shown.

import type { Json } from "./database.types";
import type { Viewer } from "./queries";
import type { AiAnalysisRow, FindingRow } from "./types";

/** What a reader gets for anyone they may not see (Austin, 6 Oct: their own name, "A team member" for everyone else). */
export const A_TEAM_MEMBER = "A team member";

/** Label → person id, as stored in `person_labels`. */
export type PersonLabels = Record<string, string>;

/** Who is reading and the names they may get: a bundle's `viewer` (absent: sees everyone) and `people`. */
export interface NameSource {
  viewer?: Viewer;
  people: readonly { id: string; name: string }[];
}

/** True when the viewer sees `personId`: everyone, or their own person. Never for a null or missing id. */
export function canSeePerson(v: Viewer, personId: string | null | undefined): boolean {
  if (v.seesEveryone) return true;
  return personId != null && personId !== "" && personId === v.ownPersonId;
}

const LABEL = /^Team member (?:[A-Z]|\d{1,4})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABELS = 500;
const NO_LETTER_OR_DIGIT_AFTER = "(?![\\p{L}\\p{N}])";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A stored map read forgivingly: labels ("Team member A", "Team member 27") to uuids; anything else dropped; at most 500. */
export function readPersonLabels(json: unknown): PersonLabels {
  const out: PersonLabels = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const [label, id] of Object.entries(json as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_LABELS) break;
    if (LABEL.test(label) && typeof id === "string" && UUID.test(id)) out[label] = id.toLowerCase();
  }
  return out;
}

/** The labels, longest first, so "Team member 27" is tried before "Team member 2". */
const longestFirst = (labels: readonly string[]) => [...labels].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

/** One pattern for every label of the map: the label, with no letter or digit after it. */
function labelPattern(labels: readonly string[]): RegExp | null {
  if (!labels.length) return null;
  return new RegExp(`(?:${longestFirst(labels).map(escapeRe).join("|")})${NO_LETTER_OR_DIGIT_AFTER}`, "gu");
}

/** The labels of `all` that occur in any of `texts` (same boundary rule as `nameLabels`). */
export function labelsUsed(texts: readonly string[], all: PersonLabels): PersonLabels {
  const pattern = labelPattern(Object.keys(all));
  const out: PersonLabels = {};
  if (!pattern) return out;
  for (const t of texts) {
    for (const m of t.matchAll(pattern)) {
      const label = m[0];
      if (label in all) out[label] = all[label]!;
    }
  }
  return out;
}

/** Whether "A team member" starts a sentence here (the start, after ". ", "! ", "? ", a newline or an opening quote). */
const startsSentence = (before: string) => /(?:^|[.!?] |\n|[“‘"'])$/u.test(before);

/**
 * Labels back to names for this reader. Longest label first ("Team member 27" before "Team member 2"); a label matches
 * only when no letter or digit follows it. The person's name when `canSeePerson`, else "A team member" ("a team member"
 * unless at the start of the text or after ". ", "! ", "? ", a newline or an opening quote). A label not in `labels` is
 * left as it is.
 */
export function nameLabels(text: string, labels: PersonLabels, who: NameSource): string {
  const pattern = labelPattern(Object.keys(labels));
  if (!pattern || !text) return text;
  const viewer = who.viewer ?? { seesEveryone: true, ownPersonId: null };
  const names = new Map(who.people.map((p) => [p.id.toLowerCase(), p.name]));
  return text.replace(pattern, (label: string, offset: number) => {
    const id = labels[label];
    // A person who is gone, or one this reader may not see.
    const name = id && canSeePerson(viewer, id) ? names.get(id.toLowerCase()) : undefined;
    if (name) return name;
    return startsSentence(text.slice(0, offset)) ? A_TEAM_MEMBER : A_TEAM_MEMBER.toLowerCase();
  });
}

/**
 * Names back to labels, for an editor's edit of an AI finding: each mapped person's full name, and their first name when
 * no other person in `people` shares it and it has 3+ letters, becomes their label (whole words; a full name in any case, a first name
 * only as written, since "will" and "mark" are words: the same rule as `applyAliases`).
 */
export function labelNames(text: string, labels: PersonLabels, people: readonly { id: string; name: string }[]): string {
  if (!text) return text;
  const firsts = new Map<string, number>();
  for (const p of people) {
    const f = p.name.trim().split(/\s+/)[0] ?? "";
    firsts.set(f.toLowerCase(), (firsts.get(f.toLowerCase()) ?? 0) + 1);
  }
  const byId = new Map(people.map((p) => [p.id.toLowerCase(), p]));
  const aliases: { name: string; label: string; first?: boolean }[] = [];
  for (const [label, id] of Object.entries(labels)) {
    const person = byId.get(id.toLowerCase());
    if (!person) continue;
    const full = person.name.trim();
    if (full.length >= 3) aliases.push({ name: full, label });
    const first = full.split(/\s+/)[0] ?? "";
    if (first.length >= 3 && first !== full && firsts.get(first.toLowerCase()) === 1) aliases.push({ name: first, label, first: true });
  }
  let out = text;
  for (const a of aliases.sort((x, y) => y.name.length - x.name.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a.name)}${NO_LETTER_OR_DIGIT_AFTER}`, a.first ? "gu" : "giu"), a.label);
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every string of a list of citations ({ kind, key, text }) named; the rest of each is as it was. */
function nameFacts(facts: Json, name: (s: string) => string): Json {
  if (!Array.isArray(facts)) return facts;
  return facts.map((f) => (isObject(f) && typeof f.text === "string" ? { ...f, text: name(f.text) } : f)) as Json;
}

/** True for a reader who does not see everyone: a member or viewer. */
const readsLess = (who: NameSource): boolean => !!who.viewer && !who.viewer.seesEveryone;

/**
 * A finding with its title, evidence, why and every fact's text named for this reader. Other fields unchanged, except
 * `ai_key` for a reader who doesn't see everyone: the stored key is a hash of the real-name title, so a member could hash
 * a guessed name and check it against the finding. They get the finding's row id instead (nothing a member can do sends
 * it back: members are read-only, and the key is used only to avoid listing the same proposal twice).
 */
export function nameFinding<T extends Pick<FindingRow, "id" | "title" | "evidence" | "why" | "facts" | "person_labels"> & Partial<Pick<FindingRow, "ai_key">>>(row: T, who: NameSource): T {
  const base: T = readsLess(who) && row.ai_key ? { ...row, ai_key: row.id } : row;
  const labels = readPersonLabels(base.person_labels);
  if (!Object.keys(labels).length) return base;
  const name = (s: string) => nameLabels(s, labels, who);
  return { ...base, title: name(base.title), evidence: name(base.evidence), why: name(base.why), facts: nameFacts(base.facts, name) };
}

/**
 * An analysis row with summary paragraphs, insights (title, evidence, why, facts[].text), review texts and reason named.
 * For a reader who doesn't see everyone, an insight's stored `key` (pre-B17 analyses; a hash of its real-name title, so a
 * guessed name could be checked against it) becomes `ai:insight:<analysis id>:<position>`: stable, and not derived from the text.
 */
export function nameAnalysisRow<T extends Pick<AiAnalysisRow, "id" | "summary" | "insights" | "review" | "reason" | "person_labels">>(row: T, who: NameSource): T {
  const base: T =
    readsLess(who) && Array.isArray(row.insights)
      ? { ...row, insights: row.insights.map((x, i) => (isObject(x) && typeof x.key === "string" ? { ...x, key: `ai:insight:${row.id}:${i}` } : x)) as Json }
      : row;
  const labels = readPersonLabels(base.person_labels);
  if (!Object.keys(labels).length) return base;
  const name = (s: string) => nameLabels(s, labels, who);
  const each = (json: Json, f: (o: Record<string, unknown>) => Record<string, unknown>): Json => (Array.isArray(json) ? (json.map((x) => (isObject(x) ? f(x) : x)) as Json) : json);
  const text = (o: Record<string, unknown>, key: string) => (typeof o[key] === "string" ? { [key]: name(o[key] as string) } : {});
  return {
    ...base,
    summary: Array.isArray(base.summary) ? (base.summary.map((p) => (typeof p === "string" ? name(p) : p)) as Json) : base.summary,
    insights: each(base.insights, (o) => ({ ...o, ...text(o, "title"), ...text(o, "evidence"), ...text(o, "why"), ...(Array.isArray(o.facts) ? { facts: nameFacts(o.facts as Json, name) } : {}) })),
    review: each(base.review, (o) => ({ ...o, ...text(o, "text") })),
    reason: base.reason === null ? null : name(base.reason),
  };
}
