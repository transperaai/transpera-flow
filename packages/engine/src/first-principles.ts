// First principles for a process (issue #119, A54; docs/research/first-principles.md Part B).
//
// A consultant strips a process back to seven short answers: the job it does, hard truths against assumptions,
// requirements each owned by a named person, delete candidates, what to simplify / accelerate / automate (in that
// order), the root cause of the biggest problem, and how success is measured. This file is the pure part: the shape
// of the answers, a forgiving reader for stored JSON, the rule checks (no database, no model run, no language
// model) and the bridge to rule 11, "goals met" (`success.ts`), which reads the success measures.
//
// Nothing here touches a simulation's numbers, so no golden output moves. The checks only compare the answers
// with each other and with the people and steps of the process.

import { checkSuccessMeasures, SUCCESS_KPIS, type SuccessCheck, type SuccessKpi, type SuccessMeasure, type SuccessMeasureSource } from "./success";
import type { EngineModel, SimulationResult } from "./model";

export const FP_STEPS = [
  { key: "job", name: "The job" },
  { key: "truths", name: "Hard truths vs assumptions" },
  { key: "reqs", name: "Requirements" },
  { key: "del", name: "Delete" },
  { key: "saa", name: "Simplify, accelerate, automate" },
  { key: "why", name: "Root cause" },
  { key: "measures", name: "Success measures" },
] as const;
export type FpStepKey = (typeof FP_STEPS)[number]["key"];

/** The most items in any list, and the longest text, so a stored document stays small. */
export const FP_MAX_ITEMS = 50;
export const FP_MAX_TEXT = 2000;
export const FP_MAX_CHAIN = 10;
/** The most bytes (as JSON text) any one list may take; the database checks the same number. */
export const FP_MAX_JSON_BYTES = 524288;

export const FP_VERDICTS = ["keep", "change", "drop", "challenge"] as const;
export type FpVerdict = (typeof FP_VERDICTS)[number];
export const FP_STAGES = ["simplify", "accelerate", "automate"] as const;
export type FpStage = (typeof FP_STAGES)[number];
export const FP_KINDS = ["truth", "assumption"] as const;
export type FpKind = (typeof FP_KINDS)[number];
export const FP_COMPARATORS = ["atLeast", "atMost"] as const;
export type FpComparator = (typeof FP_COMPARATORS)[number];

/** A statement about the process: a hard truth (with its source) or an assumption (with a way to test it). */
export interface FpStatement {
  text: string;
  kind: FpKind;
  source: string;
  test: string;
  /** The model parameter it touches, if any, e.g. "step.<id>.work_hours". */
  linked_parameter: string | null;
}

/** A rule the process follows, and who set it. */
export interface FpRequirement {
  text: string;
  /** A person of the workspace (People settings), which is what makes "a named person, not a team" checkable. */
  owner_person_id: string | null;
  /** The owner as typed, for someone who isn't in People (a client's finance director). */
  owner_text: string;
  why: string;
  verdict: FpVerdict;
  /** The step the requirement creates, if any. */
  step_id: string | null;
}

export interface FpDeleteCandidate {
  step_id: string;
  breaks_if_removed: string;
  /** The person who has to agree (a person id). */
  agreed_by: string | null;
  /** Tried and put back: the "add back" that Musk's 1-in-10 rule of thumb counts. */
  added_back: boolean;
}

export interface FpImprovement {
  step_id: string | null;
  stage: FpStage;
  text: string;
  scenario_id: string | null;
}

export interface FpMeasure {
  id: string;
  text: string;
  /** The engine number it maps to; null when the simulation can't compute it. */
  kpi: SuccessKpi | null;
  comparator: FpComparator;
  /** In the KPI's own unit (a win rate is 0 to 1); null until set. */
  target: number | null;
  /** When the target should be met, as written ("6 months"). */
  horizon: string;
}

export interface FirstPrinciples {
  job: { who: string; progress: string; situation: string; done: string };
  statements: FpStatement[];
  requirements: FpRequirement[];
  deletes: FpDeleteCandidate[];
  improvements: FpImprovement[];
  why: { problem: string; chain: string[]; root: string };
  measures: FpMeasure[];
}

export function emptyFirstPrinciples(): FirstPrinciples {
  return {
    job: { who: "", progress: "", situation: "", done: "" },
    statements: [],
    requirements: [],
    deletes: [],
    improvements: [],
    why: { problem: "", chain: [""], root: "" },
    measures: [],
  };
}

// ---------------------------------------------------------------------------
// Reading stored JSON
// ---------------------------------------------------------------------------

const text = (v: unknown, max = FP_MAX_TEXT): string => (typeof v === "string" ? v.slice(0, max) : "");
const idOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : null);
const oneOf = <T extends string>(v: unknown, all: readonly T[], fallback: T): T => (typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : fallback);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)).slice(0, FP_MAX_ITEMS) : [];

/**
 * Read stored or submitted first principles into the shape above. It never throws: a field of the wrong type becomes
 * its empty value, an item that isn't an object is dropped, lists and texts are cut to their limits. (The database
 * checks only that each part is the right kind of JSON; this is where the details are held to.)
 */
export function normalizeFirstPrinciples(input: unknown): FirstPrinciples {
  const o = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const job = o.job && typeof o.job === "object" ? (o.job as Record<string, unknown>) : {};
  const why = o.why && typeof o.why === "object" ? (o.why as Record<string, unknown>) : {};
  const chain = Array.isArray(why.chain) ? why.chain.slice(0, FP_MAX_CHAIN).map((c) => text(c)) : [];
  const usedIds = new Set<string>();
  return {
    job: { who: text(job.who), progress: text(job.progress), situation: text(job.situation), done: text(job.done) },
    statements: list(o.statements).map((s) => ({
      text: text(s.text),
      kind: oneOf(s.kind, FP_KINDS, "assumption"),
      source: text(s.source),
      test: text(s.test),
      linked_parameter: idOrNull(s.linked_parameter),
    })),
    requirements: list(o.requirements).map((r) => ({
      text: text(r.text),
      owner_person_id: idOrNull(r.owner_person_id),
      owner_text: text(r.owner_text, 200),
      why: text(r.why),
      verdict: oneOf(r.verdict, FP_VERDICTS, "challenge"),
      step_id: idOrNull(r.step_id),
    })),
    deletes: list(o.deletes)
      .map((d) => ({ step_id: idOrNull(d.step_id) ?? "", breaks_if_removed: text(d.breaks_if_removed), agreed_by: idOrNull(d.agreed_by), added_back: d.added_back === true }))
      .filter((d) => d.step_id),
    improvements: list(o.improvements).map((i) => ({
      step_id: idOrNull(i.step_id),
      stage: oneOf(i.stage, FP_STAGES, "simplify"),
      text: text(i.text),
      scenario_id: idOrNull(i.scenario_id),
    })),
    why: { problem: text(why.problem), chain: chain.length ? chain : [""], root: text(why.root) },
    measures: list(o.measures).map((m, i) => {
      let id = idOrNull(m.id) ?? `m${i + 1}`;
      while (usedIds.has(id)) id += "_";
      usedIds.add(id);
      const kpi = typeof m.kpi === "string" && m.kpi in SUCCESS_KPIS ? (m.kpi as SuccessKpi) : null;
      const target = typeof m.target === "number" && Number.isFinite(m.target) ? m.target : null;
      return { id, text: text(m.text), kpi, comparator: oneOf(m.comparator, FP_COMPARATORS, "atLeast"), target, horizon: text(m.horizon, 100) };
    }),
  };
}

/** True when nothing has been written. */
export function isBlank(fp: FirstPrinciples): boolean {
  return countFilled(fp) === 0 && !fp.job.situation && !fp.why.problem && !fp.statements.length && !fp.measures.length && !fp.requirements.length;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Which of the seven steps have an answer. */
export function stepsFilled(fp: FirstPrinciples): Record<FpStepKey, boolean> {
  return {
    job: !!(fp.job.who.trim() && fp.job.progress.trim() && fp.job.done.trim()),
    truths: fp.statements.some((s) => s.text.trim()),
    reqs: fp.requirements.some((r) => r.text.trim()),
    del: fp.deletes.length > 0,
    saa: fp.improvements.some((i) => i.text.trim()),
    why: !!fp.why.root.trim(),
    measures: fp.measures.some((m) => m.kpi !== null && m.target !== null),
  };
}

export const countFilled = (fp: FirstPrinciples): number => Object.values(stepsFilled(fp)).filter(Boolean).length;

// ---------------------------------------------------------------------------
// Rule checks
// ---------------------------------------------------------------------------

export type FpFlagLevel = "bad" | "warn" | "ok" | "info";
export interface FpFlag {
  level: FpFlagLevel;
  /** A stable name for the rule, for tests. */
  code:
    | "job_incomplete"
    | "truth_no_source"
    | "assumption_no_test"
    | "owner_team"
    | "owner_missing"
    | "no_reason"
    | "order"
    | "order_challenged"
    | "no_deletes"
    | "deletes_summary"
    | "root_person"
    | "no_root"
    | "root_ok"
    | "measure_unmapped"
    | "measure_no_target"
    | "measure_missed"
    | "no_measures";
  text: string;
}
export type FpFlags = Record<FpStepKey, FpFlag[]>;

/** What the checks compare the answers with. */
export interface FpContext {
  steps: readonly { id: string; name: string }[];
  people: readonly { id: string; name: string }[];
  roles?: readonly { name: string }[];
  /** The success measures checked against the latest run, if there is one. */
  checks?: readonly SuccessCheck[];
}

/** Flags that need attention (the "N flags" in the header); "ok" and "info" are shown but not counted. */
export const isAttention = (f: FpFlag): boolean => f.level === "bad" || f.level === "warn";
export const countFlags = (flags: FpFlags): number => Object.values(flags).reduce((n, l) => n + l.filter(isAttention).length, 0);

const FUNCTION_WORDS = new Set([
  "legal", "finance", "hr", "sales", "marketing", "ops", "operations", "compliance", "it", "safety", "security", "accounts", "accounting", "admin",
  "support", "engineering", "product", "management", "leadership", "procurement", "everyone", "nobody", "unknown", "tbc", "company", "board",
]);
const TEAM_WORDS = /\b(team|teams|department|dept|group|committee|board|office|squad|division|function)\b/i;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Why an owner doesn't count as a named person, or null when it does. */
export function ownerProblem(r: Pick<FpRequirement, "owner_person_id" | "owner_text">, ctx: Pick<FpContext, "people" | "roles">): "missing" | "team" | null {
  if (r.owner_person_id && ctx.people.some((p) => p.id === r.owner_person_id)) return null;
  const typed = norm(r.owner_text);
  if (!typed) return "missing";
  if (ctx.people.some((p) => norm(p.name) === typed)) return null;
  const bare = typed.replace(/^the\s+/, "");
  if (TEAM_WORDS.test(typed) || FUNCTION_WORDS.has(bare) || (ctx.roles ?? []).some((role) => norm(role.name) === bare)) return "team";
  return null;
}

const BLAME = /\b(is|are|was|were|being)\s+(too\s+|just\s+|so\s+)?(slow|lazy|busy|careless|unreliable|late|overworked|incompetent|disorganis?ed|forgetful|sloppy)\b|\b(human error|forgot to|forgets to|doesn'?t care|didn'?t bother|not careful)\b/i;

/** The person a cause names, or a blaming phrase, if it stops at a person rather than something in the process. */
export function causeStopsAtPerson(cause: string, people: readonly { name: string }[]): string | null {
  const t = cause.trim();
  if (!t) return null;
  for (const p of people) {
    const full = p.name.trim();
    const first = full.split(/\s+/)[0] ?? "";
    // A full name matches in any case; a first name only as written (capitalised), so "will" and "mark" the words don't match Will and Mark.
    for (const [name, flags] of [[full, "iu"], [first, "u"]] as const) {
      if (name.length < 3) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^\\p{L}])${escaped}(?=$|[^\\p{L}])`, flags).test(t)) return full;
    }
  }
  const m = BLAME.exec(t);
  return m ? m[0] : null;
}

const HABIT = /\b(always|habit|tradition|never questioned|just because|that'?s how|no idea|unknown|don'?t know)\b/i;

const q = (s: string) => `“${s.trim() || "Untitled"}”`;

/** Run every rule check over the answers. Pure: the same answers and context give the same flags. */
export function firstPrinciplesFlags(fp: FirstPrinciples, ctx: FpContext): FpFlags {
  const out: FpFlags = { job: [], truths: [], reqs: [], del: [], saa: [], why: [], measures: [] };
  const stepName = (id: string | null) => ctx.steps.find((s) => s.id === id)?.name ?? "a step that is no longer in the process";
  const add = (key: FpStepKey, level: FpFlagLevel, code: FpFlag["code"], t: string) => out[key].push({ level, code, text: t });

  // 1. The job names a customer and an outcome.
  for (const [k, label] of [["who", "Who it serves"], ["progress", "The progress they want"], ["done", "What done looks like"]] as const) {
    if (!fp.job[k].trim()) add("job", "warn", "job_incomplete", `${label} is empty.`);
  }

  // 2. A truth needs a source; an assumption needs a test.
  for (const s of fp.statements) {
    if (!s.text.trim()) continue;
    if (s.kind === "truth" && !s.source.trim()) add("truths", "bad", "truth_no_source", `${q(s.text)} is marked as a truth but has no source. Treat it as an assumption until it has one.`);
    if (s.kind === "assumption" && !s.test.trim()) add("truths", "warn", "assumption_no_test", `${q(s.text)} has no test. How would you prove it wrong?`);
  }

  // 3. A requirement is owned by a named person, not a team, and has a reason.
  for (const r of fp.requirements) {
    if (!r.text.trim()) continue;
    const problem = ownerProblem(r, ctx);
    if (problem === "team") add("reqs", "bad", "owner_team", `${q(r.text)} is owned by ${r.owner_text.trim()}, which is a team. Name the person who set it.`);
    if (problem === "missing") add("reqs", "bad", "owner_missing", `${q(r.text)} has no owner. Name the person who set it.`);
    if (!r.why.trim() || HABIT.test(r.why)) add("reqs", "warn", "no_reason", `${q(r.text)}: the reason is ${r.why.trim() ? q(r.why) : "blank"}. That is habit, not a reason.`);
  }

  // 4. Something is proposed for deletion.
  if (!fp.deletes.length) {
    add("del", "warn", "no_deletes", "Nothing proposed for deletion. If you add back fewer than 1 in 10, you didn't delete enough.");
  } else {
    const back = fp.deletes.filter((d) => d.added_back).length;
    add(
      "del",
      back ? "ok" : "info",
      "deletes_summary",
      back
        ? `${fp.deletes.length} delete candidates, ${back} added back (${Math.round((back / fp.deletes.length) * 100)}%). At 1 in 10 or more, you deleted enough to find a limit.`
        : `${fp.deletes.length} delete candidates and none added back yet. Musk's rule of thumb: add back about 1 in 10.`,
    );
  }

  // 5. The order: simplify, then accelerate, then automate, and only on steps you have decided to keep.
  const deleting = new Set(fp.deletes.filter((d) => !d.added_back).map((d) => d.step_id));
  const challenged = new Map<string, string>();
  for (const r of fp.requirements) if (r.verdict === "challenge" && r.step_id) challenged.set(r.step_id, r.text);
  for (const i of fp.improvements) {
    if (!i.step_id || i.stage === "simplify" || !i.text.trim()) continue;
    const verb = i.stage === "automate" ? "automates" : "speeds up";
    if (deleting.has(i.step_id)) {
      add("saa", "bad", "order", `${q(i.text)} ${verb} ${stepName(i.step_id)}, which is still a delete candidate. You are speeding up or automating a step you have not decided to keep.`);
    } else if (challenged.has(i.step_id)) {
      add("saa", "warn", "order_challenged", `${q(i.text)} ${verb} ${stepName(i.step_id)}, whose requirement ${q(challenged.get(i.step_id)!)} you are still challenging. Settle the requirement first.`);
    }
  }

  // 6. The root cause is something in the process, not a person.
  if (!fp.why.root.trim()) {
    add("why", "warn", "no_root", "No root cause yet. Keep asking why until you reach something in the process, not a person.");
  } else {
    const person = causeStopsAtPerson(fp.why.root, ctx.people);
    if (person) add("why", "warn", "root_person", `The chain stops at a person (${person}). Ask why once more: what in the process lets that happen?`);
    else add("why", "ok", "root_ok", "The chain ends at a cause in the process, not a person.");
  }

  // 7. Every success measure maps to a number the simulation computes, and has a target.
  if (!fp.measures.length) add("measures", "warn", "no_measures", "No measures yet. Add two to four that the simulation can check.");
  for (const m of fp.measures) {
    const name = q(m.text || "Untitled measure");
    if (m.kpi === null) add("measures", "warn", "measure_unmapped", `${name} can't be checked by the simulation. Keep it, but it won't get a pass rate.`);
    else if (m.target === null) add("measures", "warn", "measure_no_target", `${name} has no target yet.`);
    const check = ctx.checks?.find((c) => c.measure.id === m.id);
    if (check?.status === "rated" && check.metShare < 0.5) add("measures", "bad", "measure_missed", `${name} is met in ${Math.round(check.metShare * 100)}% of runs today.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Success measures: the bridge to "goals met" (rule 11)
// ---------------------------------------------------------------------------

/** How a KPI is shown to a person: the unit, and the factor between what is stored and what is typed. */
export const SUCCESS_KPI_FORM: Record<SuccessKpi, { label: string; unit: string; scale: number }> = {
  won: { label: SUCCESS_KPIS.won, unit: "wins", scale: 1 },
  winsPerWeek: { label: SUCCESS_KPIS.winsPerWeek, unit: "wins a week", scale: 1 },
  winRate: { label: SUCCESS_KPIS.winRate, unit: "%", scale: 100 },
  newMrr: { label: SUCCESS_KPIS.newMrr, unit: "a month, in your currency", scale: 1 },
  billed: { label: SUCCESS_KPIS.billed, unit: "in your currency", scale: 1 },
  cycleHours: { label: SUCCESS_KPIS.cycleHours, unit: "working hours", scale: 1 },
  labour: { label: SUCCESS_KPIS.labour, unit: "in your currency", scale: 1 },
  wipEnd: { label: SUCCESS_KPIS.wipEnd, unit: "items", scale: 1 },
};

/** A target as a person reads it: "at least 25 %", "at most 21 working hours". */
export function describeTarget(m: Pick<FpMeasure, "kpi" | "comparator" | "target">): string {
  if (m.target === null) return "No target";
  const form = m.kpi ? SUCCESS_KPI_FORM[m.kpi] : null;
  const shown = Math.round(m.target * (form?.scale ?? 1) * 100) / 100;
  return `${m.comparator === "atLeast" ? "at least" : "at most"} ${shown}${form ? ` ${form.unit}` : ""}`;
}

/** The measures as rule 11 reads them. `processId` ties each finding to the process (for rule overrides on a process). */
export function successMeasureSource(fp: FirstPrinciples, processId?: string | null): SuccessMeasureSource {
  const measures: SuccessMeasure[] = fp.measures
    .filter((m) => m.text.trim() || m.kpi)
    .map((m) => ({
      id: m.id,
      name: m.text.trim() || (m.kpi ? SUCCESS_KPIS[m.kpi] : "Success measure"),
      kpi: m.kpi,
      direction: m.comparator,
      // A measure with no target is "not checked", not a target of zero.
      target: m.target ?? Number.NaN,
      processId: processId ?? null,
    }));
  return { measures: () => measures };
}

/** Each measure with the share of replications that meet it today, or null when the simulation can't say. */
export function measuresMetToday(fp: FirstPrinciples, model: EngineModel, result: SimulationResult, processId?: string | null): { measure: FpMeasure; check: SuccessCheck | null; metShare: number | null }[] {
  const checks = checkSuccessMeasures(successMeasureSource(fp, processId), model, result);
  return fp.measures.map((measure) => {
    const check = checks.find((c) => c.measure.id === measure.id) ?? null;
    return { measure, check, metShare: check?.status === "rated" ? check.metShare : null };
  });
}

/** The numbers on the process page's summary card. */
export function firstPrinciplesSummary(fp: FirstPrinciples): { job: string; challenged: number; deleteCandidates: number; root: string; filled: number } {
  return {
    job: fp.job.progress.trim(),
    challenged: fp.requirements.filter((r) => r.verdict === "challenge").length,
    deleteCandidates: fp.deletes.filter((d) => !d.added_back).length,
    root: fp.why.root.trim(),
    filled: countFilled(fp),
  };
}

/**
 * The lists (by their stored names) that are too large to store: over `FP_MAX_JSON_BYTES` as JSON text. The counts and
 * text lengths are bounded by `normalizeFirstPrinciples`, but not their bytes (a 2,000-character text can be 8 KB of
 * emoji), so a save checks this too.
 */
export function oversizedParts(fp: FirstPrinciples): string[] {
  const parts: Record<string, unknown> = { statements: fp.statements, requirements: fp.requirements, deletes: fp.deletes, improvements: fp.improvements, why_chain: fp.why.chain, measures: fp.measures };
  const enc = new TextEncoder();
  return Object.entries(parts).filter(([, v]) => enc.encode(JSON.stringify(v)).length > FP_MAX_JSON_BYTES).map(([k]) => k);
}
