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
// Filling the value in (a person edits it, or confirms it) replaces the marker, so the gap clears. Pure: no I/O.

import type { ProcessFile } from "./process-file";
import type { ProcessBundle, StepRow } from "./types";

/** What a step's provenance note starts with when its value is the server's default for the kind of step (building tools write it). */
export const SERVER_DEFAULT_NOTE_PREFIX = "Server default for a";

export type GapKind = "role" | "hands_on" | "wait" | "odds" | "volume";

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
  /** For a file: it carries lead volume as a suggestion, so the volume gap says to accept it. */
  volumeSuggested?: boolean;
}

export type GapFix = { type: "step"; stepId: string } | { type: "settings"; where: "demand" | "services" };

export interface SimulationGap {
  kind: GapKind;
  stepId: string | null;
  stepName: string | null;
  /** In plain words: "Write proposal has no hands-on time". */
  text: string;
  fix: GapFix;
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
          : input.volumeSuggested
            ? "No incoming volume yet: accept the lead volume suggestion, or add it in Settings"
            : "No incoming volume: add lead volume in Settings or accept the suggestion",
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
export function gapInputFromFile(file: ProcessFile, opts: { hasRole: (role: string) => boolean; volume: GapInput["volume"]; volumeSuggested?: boolean }): GapInput {
  const outgoing = new Map<string, ProcessFile["links"]>();
  for (const l of file.links) outgoing.set(l.from, [...(outgoing.get(l.from) ?? []), l]);
  // A reason for assuming a value is not a value: without a number the importer still fills in its default.
  const stated = (value: number | undefined, evidence: { value?: number }[] | undefined, range: unknown) =>
    value !== undefined || !!evidence?.some((c) => c.value !== undefined) || range !== undefined;
  return {
    kind: file.kind,
    volume: opts.volume,
    ...(opts.volumeSuggested ? { volumeSuggested: true } : {}),
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
        odds: kind !== "decision" || leaving.length < 2 || leaving.every((l) => stated(l.probability, l.evidence, undefined)),
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
function oddsDefaulted(step: Pick<StepRow, "provenance">): boolean {
  const p = (step.provenance as Record<string, unknown> | undefined)?.branch_odds;
  return isObject(p) && p.defaulted === true;
}

/**
 * The check's input for a process's model. `bundle.steps` are the steps of this process in this version (a draft or live); the
 * company map has no simulation and no gaps. Demand is read from the bundle when it was loaded (`leadSources`,
 * `servicingLinks`); a bundle without it says "unknown" and no volume gap is raised.
 */
export function gapInputFromBundle(bundle: Pick<ProcessBundle, "steps" | "edges" | "process" | "leadSources" | "servicingLinks">): GapInput {
  const leaving = new Map<string, number>();
  for (const e of bundle.edges) leaving.set(e.from_step_id, (leaving.get(e.from_step_id) ?? 0) + 1);
  const kind = bundle.process.kind;
  let volume: GapInput["volume"] = "unknown";
  if (kind === "pipeline" && bundle.leadSources) volume = bundle.leadSources.some((l) => Number(l.volume_week) > 0) ? "known" : "missing";
  if (kind === "servicing" && bundle.servicingLinks) volume = bundle.servicingLinks.some((l) => l.process_id === bundle.process.id) ? "known" : "missing";
  return {
    kind,
    volume,
    steps: bundle.steps.map((s): GapStep => {
      const k = s.kind === "task" ? "work" : s.kind === "wait" ? "wait" : s.kind === "decision" ? "decision" : "other";
      return {
        id: s.id,
        name: s.name,
        kind: k,
        role: s.role_id !== null,
        handsOn: !isDefaulted(s, "work_hours"),
        wait: !isDefaulted(s, "wait_hours"),
        odds: k !== "decision" || (leaving.get(s.id) ?? 0) < 2 || !oddsDefaulted(s),
      };
    }),
  };
}
