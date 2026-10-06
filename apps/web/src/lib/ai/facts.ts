// What AI analysis is given, and what its output is checked against (issue #111, A46; docs/adr/0013-ai-analysis.md,
// docs/adr/0011-narration.md). Pure: the same run, findings and first principles give the same input.
//
// The model reads more than it may quote. It is sent the run's headline results, the rule findings, the first
// principles (the team's own words), the first-principles rule checks and, if the workspace allows, a few quotes from
// linked sources. But the figures its text may state are only those the engine produced: the results, the findings'
// own sentences, the success measures and their pass rates, and the rule checks' sentences. The first principles'
// and the quotes' own digits ("within 4 hours") are not facts, so the model can't state them as numbers; a target the
// team set shows up through its measure ("at most 21 working hours; met in 62% of runs"), which the engine wrote.
//
// Privacy as for narration: people's names become labels ("Team member A") and are mapped back after the check; the
// workspace name and the people's utilisation never go. Quotes are short, and only when the switch is on.

import { createHash } from "node:crypto";
import type { PersonLabels, RunResults } from "@transpera-flow/db";
import { describeTarget, RATING_LABELS, type DetectedIssue, type FirstPrinciples, type FpFlags, type FpStepKey, type SuccessCheck, FP_STEPS } from "@transpera-flow/engine";
import { formatIssueCost } from "@/lib/issues/register";
import { formatPercent } from "@/lib/format";
import { context, headlineResults } from "@/lib/narration/facts";
import type { CheckContext, Fact } from "@/lib/narration/numbers";

/** Bump when the payload or the prompt changes, so a stored analysis is seen as out of date. */
export const AI_PROMPT_VERSION = 3;

export interface AiInputArgs {
  processName: string;
  results: RunResults;
  /** The rule findings of the run (what the Insights list shows from the rules), worst first. */
  findings: readonly DetectedIssue[];
  /** The process's steps (its own and those inside it), for naming where a finding sits and for the AI to point at. */
  steps: readonly { id: string; name: string }[];
  roles: readonly { name: string }[];
  people: readonly { id: string; name: string }[];
  firstPrinciples: FirstPrinciples | null;
  /** The first-principles rule checks, as the process page shows them. */
  flags: FpFlags | null;
  /** The success measures with the share of runs that meet each today. */
  measures: readonly { measure: FirstPrinciples["measures"][number]; check: SuccessCheck | null; metShare: number | null }[];
  /** Short quotes from the sources linked to steps; null when the workspace hasn't switched source reading on. */
  quotes: readonly { step: string; quote: string }[] | null;
  /** Whether a market schedule is in the run (no figures: it only tells the model the months aren't all alike). */
  marketOn: boolean;
  currency: string;
  /** What is analysed: one process, or the whole company (its company model). Only the wording the model reads differs. */
  scope?: "process" | "company";
}

/** A fact the model may cite, by the id it was given: the engine finding's key and how it reads. */
export interface AiFactRef {
  id: string;
  key: string;
  text: string;
}

export interface AiInput {
  /** What the model is sent (people's names already replaced by labels). */
  payload: Record<string, unknown>;
  /** What its text is checked against. */
  check: CheckContext;
  /** Real name → label, for the payload. */
  aliases: { id: string; name: string; label: string; first?: boolean }[];
  /** Every person's label → their id: what is saved beside the text, so names go back at render per reader (B1 2b). */
  personLabels: PersonLabels;
  /** The step ids it may point at, with their names. */
  steps: { id: string; name: string }[];
  /** Every string the model was given, lower-cased and squeezed, so a quotation in its text can be matched to what it was given. */
  quotes: string[];
  /** SHA-256 of the payload and prompt version: the same hash means the stored analysis is current. */
  hash: string;
  /** The engine's facts by the id the model cites them with (B17). */
  facts: AiFactRef[];
  /** The quotes by the id the model cites them with: the step each is cited on, and its words. */
  quoteRefs: AiFactRef[];
}

/** "a", "b", ... "z", "aa", "ab": ids with no digits, so no id can pass the number check as a figure. */
export function letters(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** People's names to labels: the full name, and the first name where it is unambiguous and long enough to be a name. */
export function aliasesFor(people: readonly { id: string; name: string }[]): { id: string; name: string; label: string; first?: boolean }[] {
  const out: { id: string; name: string; label: string; first?: boolean }[] = [];
  const firsts = new Map<string, number>();
  for (const p of people) {
    const f = p.name.trim().split(/\s+/)[0] ?? "";
    firsts.set(f.toLowerCase(), (firsts.get(f.toLowerCase()) ?? 0) + 1);
  }
  people.forEach((p, i) => {
    const label = `Team member ${i < 26 ? String.fromCharCode(65 + i) : `${i + 1}`}`;
    const full = p.name.trim();
    if (full.length >= 3) out.push({ id: p.id, name: full, label });
    const first = full.split(/\s+/)[0] ?? "";
    if (first.length >= 3 && first !== full && firsts.get(first.toLowerCase()) === 1) out.push({ id: p.id, name: first, label, first: true });
  });
  return out;
}

/**
 * Names to labels in a text (longest names first, whole words only). A full name matches in any case; a first name only
 * as written, so "Will" the name is relabelled but "will" the word, and "Mark" in "Mark invoice paid" only as capitalised.
 */
export function applyAliases(text: string, aliases: readonly { name: string; label: string; first?: boolean }[]): string {
  let out = text;
  for (const a of [...aliases].sort((x, y) => y.name.length - x.name.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a.name)}(?![\\p{L}\\p{N}])`, a.first ? "gu" : "giu"), a.label);
  }
  return out;
}

function mapStrings<T>(value: T, f: (s: string) => string): T {
  if (typeof value === "string") return f(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)])) as T;
  return value;
}

/** Lower-case, one space between words, curly quotes made straight: how quotations are compared. */
export const squeeze = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Every string the model was given, squeezed: a quotation in its answer must be a passage of these (a step, a first-principles answer, a source's quote), or it is made up. */
export function wordsGiven(payload: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(squeeze(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(payload);
  return out;
}

/** A text with its quoted passages (“…” or "…", the team's own words in the rule checks) left out. */
export const stripQuoted = (s: string): string => s.replace(/“[^”]*”/g, "“…”").replace(/"[^"]*"/g, '"…"');

/**
 * The text a ratio phrase ("1 in 10") may be exempt by, because the engine printed it: the rule checks, the measures'
 * target and pass rate, the results and the findings' evidence, with every name (process, step, role) cut out, since a
 * team can name a step "1 in 3 escalation flow".
 */
export function exemptPhrases(checkPayload: Record<string, unknown>, names: readonly string[]): string[] {
  const source = {
    checks: (checkPayload.firstPrinciplesChecks as { text: string }[]).map((c) => c.text),
    measures: checkPayload.successMeasures,
    results: checkPayload.results,
    evidence: (checkPayload.findings as { evidence: string }[]).map((f) => f.evidence),
  };
  const byLength = [...names].filter((n) => n.trim()).sort((a, b) => b.length - a.length);
  return wordsGiven(source).map((p) => byLength.reduce((text, n) => text.split(squeeze(n)).join(" "), p));
}

const MAX_QUOTES = 12;
const MAX_QUOTE_CHARS = 220;

/** The first-principles answers the model reads, in the team's own words (no figures of theirs are facts). */
function firstPrinciplesPayload(
  fp: FirstPrinciples,
  steps: readonly { id: string; name: string }[],
  people: readonly { id: string; name: string }[],
  typed: (s: string) => string,
) {
  const stepName = (id: string | null) => steps.find((s) => s.id === id)?.name ?? null;
  const personName = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  // What people typed (the job, truths, requirements, improvements, the why chain) may name a person by first name; step names
  // and the engine's own words may not be read that way ("Mark invoice paid" is a step, not Mark Lee).
  const t = <V>(v: V): V => mapStrings(v, typed);
  return {
    job: t(fp.job),
    truthsAndAssumptions: fp.statements.filter((s) => s.text.trim()).map((s) => t({ text: s.text, kind: s.kind, source: s.source, test: s.test })),
    requirements: fp.requirements
      .filter((r) => r.text.trim())
      .map((r) => ({ text: t(r.text), owner: personName(r.owner_person_id) ?? (r.owner_text.trim() ? t(r.owner_text.trim()) : null), why: t(r.why), verdict: r.verdict, step: stepName(r.step_id) })),
    deleteCandidates: fp.deletes.map((d) => ({ step: stepName(d.step_id), breaksIfRemoved: t(d.breaks_if_removed), addedBack: d.added_back })),
    improvements: fp.improvements.filter((i) => i.text.trim()).map((i) => ({ stage: i.stage, text: t(i.text), step: stepName(i.step_id) })),
    why: t(fp.why),
  };
}

/** Build what the model is sent and what its answer is checked against. */
export function buildAiInput(args: AiInputArgs): AiInput {
  const { results: r, findings, steps, flags, measures } = args;
  const head = headlineResults(r);
  const stepName = (id: string | null) => steps.find((s) => s.id === id)?.name ?? null;

  const findingsPayload = findings.map((f) => ({
    title: f.title,
    rating: RATING_LABELS[f.rating],
    step: stepName(f.stepId),
    evidence: f.evidence,
    cost: formatIssueCost(f.cost, args.currency),
  }));
  const checks = flags
    ? FP_STEPS.flatMap((s) => (flags[s.key as FpStepKey] ?? []).map((f) => ({ step: s.key, level: f.level, check: f.code, text: f.text })))
    : [];
  const measuresPayload = measures.map((m) => ({
    measure: m.measure.text || (m.measure.kpi ?? "Success measure"),
    target: describeTarget(m.measure),
    today: m.metShare === null ? "the simulation can't check this one" : `met in ${formatPercent(m.metShare)} of runs`,
  }));

  // Figures the text may state: engine-written only.
  const factPayload: Record<string, unknown> = {
    run: { process: args.processName, ...head.run },
    results: head.results,
    findings: findingsPayload,
    firstPrinciplesChecks: checks,
    successMeasures: measuresPayload,
  };
  const raw: Fact[] = [...head.raw];

  const quotes = (args.quotes ?? [])
    .slice(0, MAX_QUOTES)
    .map((q) => ({ step: q.step, quote: q.quote.trim().slice(0, MAX_QUOTE_CHARS) }))
    .filter((q) => q.quote)
    .map((q, i) => ({ id: `quote-${letters(i)}`, ...q }));
  const aliases = aliasesFor(args.people);
  // The engine's text (a finding's title and evidence, step and role names) names people by their full name, which is what
  // the model is given from the model; a first name in it is just a word ("Mark invoice paid"). Only what people typed
  // (quotes from sources, first principles) also gets first names aliased.
  const fullNames = aliases.filter((a) => !a.first);
  const typed = (s: string) => applyAliases(s, aliases);
  // The facts the model cites by id (B17): each finding of the engine's, by an id with no digits in it. Their text is saved
  // with the finding, so it is labelled like everything else the model wrote: names go back at render (B1 2b).
  const factRefs: AiFactRef[] = findings.map((f, i) => ({ id: `fact-${letters(i)}`, key: f.key, text: applyAliases(`${f.title}. ${f.evidence}`.slice(0, 600), fullNames) }));
  const payload = mapStrings(
    {
      ...factPayload,
      scope: args.scope === "company" ? "The whole company: every process, role, person and client group in the company model." : `One process: ${args.processName}.`,
      findings: findingsPayload.map((f, i) => ({ id: factRefs[i]!.id, ...f })),
      market: args.marketOn ? "A market schedule is switched on, so some months are busier or quieter than others." : "No market changes are scheduled.",
      steps: steps.map((s) => ({ id: s.id, name: s.name })),
      firstPrinciples: args.firstPrinciples ? firstPrinciplesPayload(args.firstPrinciples, steps, args.people, typed) : null,
      ...(args.quotes ? { quotesFromSources: quotes.map((q) => ({ ...q, quote: typed(q.quote) })) } : {}),
    },
    (s) => applyAliases(s, fullNames),
  );
  // What the check reads figures from. The model sees the team's words (a measure's name, a quoted answer), but a figure
  // inside them is theirs, not the run's: so the checked copy has no quoted passages in the rule checks, no measure
  // names, and none of the measure's name in a "Goal not reliably met" title (rule 11 embeds it).
  const checkPayload = mapStrings(
    {
      ...factPayload,
      findings: findingsPayload.map((f, i) => (findings[i]!.key.startsWith("success:") ? { ...f, title: "Goal not reliably met" } : f)),
      firstPrinciplesChecks: checks.map((c) => ({ ...c, text: stripQuoted(c.text).replace(/ is owned by [\s\S]*?, which is a team\./, " is owned by a team, which is a team.") })),
      successMeasures: measuresPayload.map(({ target, today }) => ({ target, today })),
    },
    (s) => applyAliases(s, fullNames),
  );

  const names = [args.processName, ...steps.map((s) => s.name), ...args.roles.map((x) => x.name), ...aliases.map((a) => a.label)];
  return {
    payload,
    check: { ...context(checkPayload, raw, [], names, r.currency, r.hours_per_week), phrases: exemptPhrases(checkPayload, names) },
    aliases,
    personLabels: Object.fromEntries(aliases.map((a) => [a.label, a.id])),
    steps: steps.map((s) => ({ id: s.id, name: s.name })),
    quotes: wordsGiven(payload),
    facts: factRefs,
    quoteRefs: quotes.map((q) => ({ id: q.id, key: q.step, text: applyAliases(q.quote, aliases) })),
    hash: createHash("sha256").update(JSON.stringify({ v: AI_PROMPT_VERSION, payload })).digest("hex"),
  };
}
