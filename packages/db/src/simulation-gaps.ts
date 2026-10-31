// "Missing for simulation" (issue #167, B14): the useful minimum a process needs before its numbers mean something, and where it
// is still missing. One check, run three ways: on an uploaded file (the preview), and on a process's live or draft model (the
// process page and the editor), so the same gap reads the same in all of them.
//
// The useful minimum (a person's call, 5 Oct 2026):
//   1. a role on every work step;
//   2. hands-on time on every work step;
//   3. a wait on every wait step;
//   4. odds on every branch of a decision;
//   5. incoming volume: lead volume for a pipeline, a recurrence for a servicing process.
//
// A gap is an ABSENT value, not an uncertain one. A number the file states, backs with a quote or marks "assumed: reason" is
// present (it may still be listed as an assumption to confirm: that is the existing checklist). A number the importer had to
// fill in because nothing was given is absent, and it is marked when it is filled in so it can be found again:
//   * a step's hands-on time or wait that took the server default has a provenance note starting with SERVER_DEFAULT_NOTE_PREFIX;
//   * a step whose branches took the share the others leave has `provenance.branch_odds.defaulted`, which goes away the moment
//     anyone writes one of its branches' probabilities (a trigger, migration 20261129000000).
// Filling the value in (a person edits it, or confirms it) replaces the marker, so the gap clears.
//
// Capacity (P4, docs/plans/capacity/p4-editor-brief.md) adds two kinds of line to the same list, from `capacityGaps`:
//   * blockers: what the engine's `capacityProblems` names (a split that doesn't add up, a servicing link that follows a deliverable
//     its service doesn't have, a step for the client's manager with no role). The run goes ahead on the value the engine can use;
//     the list says what to fix.
//   * notes (`severity: "note"`): a working step of a servicing process with no work split, and a base value (a split, tier
//     multipliers) or its time with no source. Nothing is wrong with them; they are what the capacity figures would be better for.
// Pure: no I/O.

import { capacityProblems, type EngineModel } from "@transpera-flow/engine";
import type { ProcessFile } from "./process-file";
import { STEP_SOURCE_LABELS, type ProcessBundle, type StepRow } from "./types";

/** What a step's provenance note starts with when its value is the server's default for the kind of step (building tools write it). */
export const SERVER_DEFAULT_NOTE_PREFIX = "Server default for a";

export type GapKind = "role" | "hands_on" | "wait" | "odds" | "volume" | "capacity" | "split" | "source";

/** The step, in the terms the check needs: what kind of step it is, and which of its values are present. */
export interface GapStep {
  id: string;
  name: string;
  /** work: someone does it (a task). wait: items sit. decision: items branch. other: start, end, holders. */
  kind: "work" | "wait" | "decision" | "other";
  role: boolean;
  handsOn: boolean;
  wait: boolean;
  /** For a decision with two or more branches: every branch has odds. Other steps: true. */
  odds: boolean;
}

export interface GapInput {
  kind: "pipeline" | "servicing";
  steps: GapStep[];
  /** Incoming volume: known, missing, or not known here (a page that did not load demand says nothing about it). */
  volume: "known" | "missing" | "unknown";
}

export type GapFix = { type: "step"; stepId: string } | { type: "settings"; where: "demand" | "services" };

export interface SimulationGap {
  kind: GapKind;
  stepId: string | null;
  stepName: string | null;
  /** In plain words: "Write proposal has no hands-on time". */
  text: string;
  fix: GapFix;
  /** Absent or "blocker": a value the simulation lacks or can't use. "note": worth adding, nothing is wrong without it. */
  severity?: "blocker" | "note";
}

/** The gaps in a process, steps in order, then incoming volume. */
export function findGaps(input: GapInput): SimulationGap[] {
  const gaps: SimulationGap[] = [];
  const step = (s: GapStep, kind: GapKind, text: string) => gaps.push({ kind, stepId: s.id, stepName: s.name, text, fix: { type: "step", stepId: s.id } });
  for (const s of input.steps) {
    if (s.kind === "work") {
      if (!s.role) step(s, "role", `${s.name} has no role`);
      if (!s.handsOn) step(s, "hands_on", `${s.name} has no hands-on time`);
    } else if (s.kind === "wait") {
      if (!s.wait) step(s, "wait", `${s.name} has no wait time`);
    } else if (s.kind === "decision") {
      if (!s.odds) step(s, "odds", `${s.name}: branch odds missing`);
    }
  }
  if (input.volume === "missing") {
    gaps.push({
      kind: "volume",
      stepId: null,
      stepName: null,
      text:
        input.kind === "servicing"
          ? "No recurrence: link this process to a service and set how often it repeats in Settings"
          : "No incoming volume: add lead volume in Settings",
      fix: { type: "settings", where: input.kind === "servicing" ? "services" : "demand" },
    });
  }
  return gaps;
}

/** The gaps as lines of text. */
export const gapLines = (gaps: readonly SimulationGap[]): string[] => gaps.map((g) => g.text);

// ---------------------------------------------------------------------------
// From an uploaded file
// ---------------------------------------------------------------------------

/**
 * The check's input for a checked file. `hasRole` says whether a role the file names will end up on its step (the company has
 * it, or the person uploading mapped it): the preview calls this again as the person maps roles.
 */
export function gapInputFromFile(file: ProcessFile, opts: { hasRole: (role: string) => boolean; volume: GapInput["volume"]}): GapInput {
  const outgoing = new Map<string, ProcessFile["links"]>();
  for (const l of file.links) outgoing.set(l.from, [...(outgoing.get(l.from) ?? []), l]);
  // A reason for assuming a value is not a value: without a number the importer still fills in its default.
  const stated = (value: number | undefined, evidence: { value?: number }[] | undefined, range: unknown) =>
    value !== undefined || !!evidence?.some((c) => c.value !== undefined) || range !== undefined;
  return {
    kind: file.kind,
    volume: opts.volume,
    steps: file.steps.map((s): GapStep => {
      const kind = s.type === "step" ? "work" : s.type === "wait" ? "wait" : s.type === "decision" ? "decision" : "other";
      const leaving = outgoing.get(s.id) ?? [];
      return {
        id: s.id,
        name: s.name,
        kind,
        role: !!s.role && opts.hasRole(s.role),
        handsOn: stated(s.hands_on_hours, s.evidence?.hands_on_hours, s.hands_on_range),
        wait: stated(s.wait_hours, s.evidence?.wait_hours, s.wait_range),
        // One branch without odds is the share the others leave (the importer infers it); two or more are not.
        odds: kind !== "decision" || leaving.length < 2 || leaving.filter((l) => !stated(l.probability, l.evidence, undefined)).length <= 1,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// From a process's model (live or draft)
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value was filled in by the server because nothing was given, and nobody has set or confirmed it since. */
function isDefaulted(step: Pick<StepRow, "provenance">, column: "work_hours" | "wait_hours"): boolean {
  const p = step.provenance?.[column];
  return !!p && p.source === "estimated" && p.assumption === true && !p.evidence?.length && typeof p.note === "string" && p.note.startsWith(SERVER_DEFAULT_NOTE_PREFIX);
}

/** The step's branches took the share the others leave, and nobody has written one since. */
function oddsDefaulted(step: Pick<StepRow, "provenance">, out: readonly { to_step_id: string; probability: number }[]): boolean {
  const p = (step.provenance as Record<string, unknown> | undefined)?.branch_odds;
  if (!isObject(p) || p.defaulted !== true) return false;
  // The marker is taken off by the database when a probability is written; the model a person is editing hasn't heard yet, so a
  // branch that no longer has the probability it was given by default counts as filled in already.
  const was = isObject(p.was) ? p.was : null;
  if (!was) return false;
  // With at most one branch still at its defaulted value, the last is inferred (the database clears the marker at the same point).
  return out.filter((e) => was[e.to_step_id] !== undefined && Number(was[e.to_step_id]) === Number(e.probability)).length > 1;
}

/**
 * The check's input for a process's model. `bundle.steps` are the steps of this process in this version (a draft or live); the
 * company map has no simulation and no gaps. Demand is read from the bundle when it was loaded (`leadSources`,
 * `servicingLinks`); a bundle without it says "unknown" and no volume gap is raised.
 */
export function gapInputFromBundle(bundle: Pick<ProcessBundle, "steps" | "edges" | "process" | "leadSources" | "servicingLinks"> & { otherProcesses?: ProcessBundle["otherProcesses"] }): GapInput {
  const kind = bundle.process.kind;
  if (bundle.process.is_company) return { kind, volume: "unknown", steps: [] };
  // The processes held inside this one (a step that holds a child process), to any depth, count as part of it: the engine
  // simulates them in its place, so a gap in a child is a gap in the parent.
  const steps = [...bundle.steps];
  const edges = [...bundle.edges];
  const seen = new Set<string>([bundle.process.id]);
  for (let i = 0; i < steps.length; i++) {
    const child = steps[i]!.child_process_id;
    if (!child || seen.has(child)) continue;
    seen.add(child);
    const part = bundle.otherProcesses?.find((p) => p.process.id === child);
    if (part) {
      steps.push(...part.steps);
      edges.push(...part.edges);
    }
  }
  const leaving = new Map<string, { to_step_id: string; probability: number }[]>();
  for (const e of edges) leaving.set(e.from_step_id, [...(leaving.get(e.from_step_id) ?? []), e]);
  let volume: GapInput["volume"] = "unknown";
  if (kind === "pipeline" && bundle.leadSources) volume = bundle.leadSources.some((l) => Number(l.volume_week) > 0) ? "known" : "missing";
  if (kind === "servicing" && bundle.servicingLinks) volume = bundle.servicingLinks.some((l) => l.process_id === bundle.process.id) ? "known" : "missing";
  return {
    kind,
    volume,
    steps: steps.map((s): GapStep => {
      const k = s.kind === "task" ? "work" : s.kind === "wait" ? "wait" : s.kind === "decision" ? "decision" : "other";
      return {
        id: s.id,
        name: s.name,
        kind: k,
        role: s.role_id !== null,
        handsOn: !isDefaulted(s, "work_hours"),
        wait: !isDefaulted(s, "wait_hours"),
        odds: k !== "decision" || (leaving.get(s.id) ?? []).length < 2 || !oddsDefaulted(s, leaving.get(s.id) ?? []),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Capacity: base values on the steps (P4)
// ---------------------------------------------------------------------------

type CapacityBundle = Pick<ProcessBundle, "steps" | "process"> & { otherProcesses?: ProcessBundle["otherProcesses"] };

/** The process's own steps, and those of the processes held inside it to any depth (the engine simulates them in its place). */
function stepsWithChildren(bundle: CapacityBundle): StepRow[] {
  const steps = [...bundle.steps];
  const seen = new Set<string>([bundle.process.id]);
  for (let i = 0; i < steps.length; i++) {
    const child = steps[i]!.child_process_id;
    if (!child || seen.has(child)) continue;
    seen.add(child);
    const part = bundle.otherProcesses?.find((p) => p.process.id === child);
    if (part) steps.push(...part.steps);
  }
  return steps;
}

const hasSource = (step: Pick<StepRow, "provenance">, key: "work" | "split" | "tier_multiplier"): boolean => {
  const src = (step.provenance as Record<string, { source?: unknown } | undefined> | null | undefined)?.[key]?.source;
  return typeof src === "string" && (STEP_SOURCE_LABELS as readonly string[]).includes(src);
};
const nonEmpty = (v: unknown): boolean => !!v && typeof v === "object" && Object.keys(v).length > 0;

/**
 * The notes for a servicing process: each working step with no work split, and each step with a split or tier multipliers
 * and no source for them (or for its time). Nothing for a pipeline or the company map: the capacity figures are about
 * servicing. A step holding a group or a child process does no work itself, so it is left out.
 */
export function capacityNotes(bundle: CapacityBundle): SimulationGap[] {
  if (bundle.process.is_company || bundle.process.kind !== "servicing") return [];
  const out: SimulationGap[] = [];
  const note = (s: StepRow, kind: GapKind, text: string) =>
    out.push({ kind, stepId: s.id, stepName: s.name, text, fix: { type: "step", stepId: s.id }, severity: "note" });
  for (const s of stepsWithChildren(bundle)) {
    if (s.kind !== "task" || s.child_process_id) continue;
    if (!s.split) {
      note(s, "split", `${s.name} has no work split`);
      continue;
    }
    const missing: string[] = [];
    if (!hasSource(s, "split")) missing.push("split");
    if (nonEmpty(s.tier_multiplier) && !hasSource(s, "tier_multiplier")) missing.push("tier multipliers");
    if (!hasSource(s, "work")) missing.push("time");
    if (missing.length) note(s, "source", `${s.name} has no source for its ${missing.join(" and ")}`);
  }
  return out;
}

/** The step a capacity problem is about, from the path the engine gives (`steps.<id>...`). */
const stepOfPath = (where: string, ids: ReadonlySet<string>): string | null => {
  const id = /^steps\.([^.]+)/.exec(where)?.[1];
  return id && ids.has(id) ? id : null;
};

/**
 * What the engine's `capacityProblems` finds in a model, as blockers. A problem about a step links to it; the others (a service's
 * deliverables, a person's portfolio) link to Settings. `model` is null when the process can't be turned into a model yet.
 */
export function capacityBlockers(model: EngineModel | null): SimulationGap[] {
  if (!model) return [];
  const ids = new Set(model.steps.map((s) => s.id));
  const names = new Map(model.steps.map((s) => [s.id, s.name]));
  return capacityProblems(model).map((p): SimulationGap => {
    const stepId = stepOfPath(p.where, ids);
    return {
      kind: "capacity",
      stepId,
      stepName: stepId ? (names.get(stepId) ?? null) : null,
      text: p.message,
      fix: stepId ? { type: "step", stepId } : { type: "settings", where: "services" },
      severity: "blocker",
    };
  });
}

/** Blockers first (the engine's capacity problems), then the notes. Show them where "Missing for simulation" is shown. */
export function capacityGaps(bundle: CapacityBundle, model: EngineModel | null): SimulationGap[] {
  return [...capacityBlockers(model), ...capacityNotes(bundle)];
}

/** The gaps that are blockers (everything but the notes). */
export const blockersOf = (gaps: readonly SimulationGap[]): SimulationGap[] => gaps.filter((g) => g.severity !== "note");
/** The gaps that are only notes. */
export const notesOf = (gaps: readonly SimulationGap[]): SimulationGap[] => gaps.filter((g) => g.severity === "note");
