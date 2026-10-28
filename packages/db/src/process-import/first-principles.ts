// Merging what Claude read in a transcript into a process's first principles (issue #119, A54). Pure: no database, no
// language model. The tool (first-principles-tools.ts) gives it the draft's current answers and the draft's steps and
// people; it returns the new answers, the sections that changed, and a note for everything it could not place.
//
// Two modes. `merge` (the default) adds new items and updates the ones it recognises by their text (or their step),
// changing only the fields given; nothing is removed. `replace` swaps each list that is given for the one given.
// Sections that are not given are never touched in either mode.

import {
  FP_MAX_CHAIN,
  FP_MAX_ITEMS,
  FP_STEPS,
  normalizeFirstPrinciples,
  SUCCESS_KPI_FORM,
  type FirstPrinciples,
  type FpComparator,
  type FpDeleteCandidate,
  type FpImprovement,
  type FpKind,
  type FpMeasure,
  type FpRequirement,
  type FpStage,
  type FpStatement,
  type FpStepKey,
  type FpVerdict,
  type SuccessKpi,
} from "@transpera-flow/engine";
import { normalizeName, resolveName } from "./building";
import { ImportError } from "./errors";

export interface FpInput {
  job?: Partial<FirstPrinciples["job"]>;
  statements?: { text: string; kind?: FpKind; source?: string; test?: string; linked_parameter?: string | null }[];
  requirements?: { text: string; owner?: string | null; why?: string; verdict?: FpVerdict; step?: string | null }[];
  deletes?: { step: string; breaks_if_removed?: string; agreed_by?: string | null; added_back?: boolean }[];
  improvements?: { stage: FpStage; text: string; step?: string | null }[];
  why?: { problem?: string; chain?: string[]; root?: string };
  measures?: { text: string; kpi?: SuccessKpi | null; comparator?: FpComparator; target?: number | null; horizon?: string }[];
}

export type FpMode = "merge" | "replace";

export interface FpLookup {
  steps: readonly { id: string; name: string }[];
  people: readonly { id: string; name: string }[];
}

export interface FpMergeResult {
  doc: FirstPrinciples;
  /** The steps of the flow whose answers changed. */
  changed: FpStepKey[];
  /** Everything that could not be placed as given (a step that isn't in the process, an ambiguous name). */
  warnings: string[];
}

const same = (a: string, b: string) => normalizeName(a) === normalizeName(b);

/** A step or person by id or name; null, with a warning, when there is no single match. */
function lookup(items: readonly { id: string; name: string }[], ref: string | null | undefined, kind: string, warnings: string[], where: string): string | null {
  if (!ref || !ref.trim()) return null;
  try {
    return resolveName(items, ref, kind, "").id;
  } catch (err) {
    if (err instanceof ImportError) {
      const candidates = Array.isArray(err.candidates) && err.candidates.length && err.code === "ambiguous" ? ` It could be ${(err.candidates as { name: string }[]).map((c) => c.name).join(", ")}.` : "";
      warnings.push(`${where}: no single ${kind} matches '${ref}'.${candidates}`);
      return null;
    }
    throw err;
  }
}

/** Items from `input` merged into `current` by `key`, or replacing it. `patch` builds an item; `update` changes an existing one. */
function mergeList<I, T>(current: readonly T[], input: readonly I[] | undefined, mode: FpMode, keyOf: (i: T) => string, build: (i: I) => T | null, update: (existing: T, i: I) => T): T[] {
  if (input === undefined) return [...current];
  const out: T[] = mode === "replace" ? [] : [...current];
  for (const i of input) {
    const fresh = build(i);
    if (!fresh) continue;
    const at = out.findIndex((x) => keyOf(x) === keyOf(fresh));
    if (at >= 0) out[at] = mode === "replace" ? fresh : update(out[at]!, i);
    else out.push(fresh);
  }
  if (out.length > FP_MAX_ITEMS) throw new ImportError("invalid_input", `A list can hold at most ${FP_MAX_ITEMS} items; this one would have ${out.length}.`);
  return out;
}

const given = <T,>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);

export function mergeFirstPrinciples(current: FirstPrinciples, input: FpInput, ctx: FpLookup, mode: FpMode = "merge"): FpMergeResult {
  const warnings: string[] = [];
  const next: FirstPrinciples = {
    ...current,
    job: { ...current.job, ...Object.fromEntries(Object.entries(input.job ?? {}).filter(([, v]) => typeof v === "string")) },
  };

  next.statements = mergeList<NonNullable<FpInput["statements"]>[number], FpStatement>(
    current.statements,
    input.statements,
    mode,
    (s) => normalizeName(s.text),
    (s) => (s.text.trim() ? { text: s.text.trim(), kind: s.kind ?? "assumption", source: s.source ?? "", test: s.test ?? "", linked_parameter: s.linked_parameter ?? null } : null),
    (e, s) => ({ ...e, kind: given(s.kind, e.kind), source: given(s.source, e.source), test: given(s.test, e.test), linked_parameter: given(s.linked_parameter, e.linked_parameter) }),
  );

  const owner = (ref: string | null | undefined, label: string): Pick<FpRequirement, "owner_person_id" | "owner_text"> | null => {
    if (ref === undefined) return null;
    if (ref === null || !ref.trim()) return { owner_person_id: null, owner_text: "" };
    const id = lookup(ctx.people, ref, "person", [], label);
    // Not in People: kept as the name given, which the checks read (a team or role name is flagged).
    return id ? { owner_person_id: id, owner_text: "" } : { owner_person_id: null, owner_text: ref.trim() };
  };
  next.requirements = mergeList<NonNullable<FpInput["requirements"]>[number], FpRequirement>(
    current.requirements,
    input.requirements,
    mode,
    (r) => normalizeName(r.text),
    (r) => {
      if (!r.text.trim()) return null;
      const o = owner(r.owner, r.text) ?? { owner_person_id: null, owner_text: "" };
      return { text: r.text.trim(), ...o, why: r.why ?? "", verdict: r.verdict ?? "challenge", step_id: lookup(ctx.steps, r.step, "step", warnings, `Requirement '${r.text}'`) };
    },
    (e, r) => {
      const o = owner(r.owner, r.text);
      return {
        ...e,
        ...(o ?? {}),
        why: given(r.why, e.why),
        verdict: given(r.verdict, e.verdict),
        step_id: r.step === undefined ? e.step_id : lookup(ctx.steps, r.step, "step", warnings, `Requirement '${r.text}'`),
      };
    },
  );

  next.deletes = mergeList<NonNullable<FpInput["deletes"]>[number], FpDeleteCandidate>(
    current.deletes,
    input.deletes,
    mode,
    (d) => d.step_id,
    (d) => {
      const step_id = lookup(ctx.steps, d.step, "step", warnings, "Delete candidate");
      if (!step_id) return null;
      return { step_id, breaks_if_removed: d.breaks_if_removed ?? "", agreed_by: lookup(ctx.people, d.agreed_by, "person", warnings, `Delete candidate '${d.step}'`), added_back: d.added_back === true };
    },
    (e, d) => ({
      ...e,
      breaks_if_removed: given(d.breaks_if_removed, e.breaks_if_removed),
      agreed_by: d.agreed_by === undefined ? e.agreed_by : lookup(ctx.people, d.agreed_by, "person", warnings, `Delete candidate '${d.step}'`),
      added_back: given(d.added_back, e.added_back),
    }),
  );

  next.improvements = mergeList<NonNullable<FpInput["improvements"]>[number], FpImprovement>(
    current.improvements,
    input.improvements,
    mode,
    (i) => `${i.stage}|${normalizeName(i.text)}`,
    (i) => (i.text.trim() ? { step_id: lookup(ctx.steps, i.step, "step", warnings, `Change '${i.text}'`), stage: i.stage, text: i.text.trim(), scenario_id: null } : null),
    (e, i) => ({ ...e, step_id: i.step === undefined ? e.step_id : lookup(ctx.steps, i.step, "step", warnings, `Change '${i.text}'`) }),
  );

  if (input.why) {
    const chain = input.why.chain?.slice(0, FP_MAX_CHAIN).map((c) => c.trim()).filter(Boolean);
    next.why = {
      problem: given(input.why.problem, current.why.problem),
      chain: chain ? (chain.length ? chain : [""]) : current.why.chain,
      root: given(input.why.root, current.why.root),
    };
  }

  const kpiScale = (kpi: SuccessKpi | null) => (kpi ? SUCCESS_KPI_FORM[kpi].scale : 1);
  // A target arrives in the unit a person reads (a win rate as 30, meaning 30%) and is stored in the engine's (0.3).
  const target = (m: { kpi?: SuccessKpi | null; target?: number | null }, kpi: SuccessKpi | null): number | null | undefined =>
    m.target === undefined ? undefined : m.target === null ? null : m.target / kpiScale(kpi);
  next.measures = mergeList<NonNullable<FpInput["measures"]>[number], FpMeasure>(
    current.measures,
    input.measures,
    mode,
    (m) => normalizeName(m.text),
    (m) => {
      if (!m.text.trim()) return null;
      const kpi = m.kpi ?? null;
      // The id is given below, once it is known which items are new.
      return { id: "", text: m.text.trim(), kpi, comparator: m.comparator ?? "atLeast", target: target(m, kpi) ?? null, horizon: m.horizon ?? "" };
    },
    (e, m) => {
      const kpi = m.kpi === undefined ? e.kpi : m.kpi;
      const t = target(m, kpi);
      return { ...e, kpi, comparator: given(m.comparator, e.comparator), target: t === undefined ? (kpi === e.kpi ? e.target : null) : t, horizon: given(m.horizon, e.horizon) };
    },
  );
  // A replaced measure keeps the id of the one with the same text, so findings keyed on it carry over; a new one takes the next free id.
  // (An id that was dropped is not handed out again to a different measure.)
  const reused = new Set(next.measures.map((m) => m.id).filter(Boolean));
  const used = new Set([...reused, ...current.measures.map((c) => c.id)]);
  if (mode === "replace") {
    next.measures = next.measures.map((m) => {
      const before = m.id ? null : current.measures.find((c) => same(c.text, m.text) && !reused.has(c.id));
      if (before) reused.add(before.id);
      return before ? { ...m, id: before.id } : m;
    });
  }
  next.measures = next.measures.map((m) => {
    if (m.id) return m;
    let n = 1;
    while (used.has(`m${n}`)) n++;
    used.add(`m${n}`);
    return { ...m, id: `m${n}` };
  });

  const doc = normalizeFirstPrinciples(next);
  const was = normalizeFirstPrinciples(current);
  const section: Record<FpStepKey, (d: FirstPrinciples) => unknown> = {
    job: (d) => d.job,
    truths: (d) => d.statements,
    reqs: (d) => d.requirements,
    del: (d) => d.deletes,
    saa: (d) => d.improvements,
    why: (d) => d.why,
    measures: (d) => d.measures,
  };
  const changed = FP_STEPS.map((s) => s.key).filter((k) => JSON.stringify(section[k](doc)) !== JSON.stringify(section[k](was)));
  return { doc, changed, warnings: [...new Set(warnings)] };
}
