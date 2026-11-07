// What stops a process simulating, by node (editor brainstorm, item 4): each problem shows on its step or line as a red mark that
// explains itself on hover, and the editor bar says how many there are ("2 things to fix before this can simulate"). Pure.
//
// Built from three things, so the editor and Publish agree:
// - `stepWarnings` (./commands.ts): no way out, branches that don't add up to 100%;
// - the `ModelError` `toEngineModel` throws on the draft (the very error that blocks Publish today), pinned to the step or line it
//   names when it names one in quotes, else a process-level entry;
// - a decision whose shares don't add up to 100% (already one of `stepWarnings`; kept here so the rule is stated once for decisions).
//
// `toEngineModel` stops at the first thing wrong, so `total` counts that one plus everything `stepWarnings` found.

import { ModelError, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import { outgoingTotal, stepWarnings } from "./commands";

export interface NodeProblems {
  /** Plain-English problems by step id. */
  steps: Map<string, string[]>;
  /** ...and by line id. */
  edges: Map<string, string[]>;
  /** Problems that name no step or line (the whole process), in plain English. */
  process: string[];
  /** Every problem above, counted once. */
  total: number;
}

/** Probabilities within this of 100% count as 100% (as `stepWarnings` does). */
const TOLERANCE = 1e-6;
/** A date only to make the model; no problem depends on it. */
const MODEL_DATE = "2026-01-05";

const add = (map: Map<string, string[]>, id: string, message: string) => {
  const list = map.get(id) ?? [];
  if (!list.includes(message)) map.set(id, [...list, message]);
};

/** The sentence a ModelError message becomes: first letter up, a full stop at the end. */
function sentence(message: string): string {
  const m = message.trim();
  const up = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
}

/** The names a message puts in single quotes, in order. */
const quoted = (message: string): string[] => [...message.matchAll(/'([^']*)'/g)].map((m) => m[1]!);

/** Pin a model error to the steps or lines it names. Returns false when it names none (a process-level problem). */
function pin(bundle: ProcessBundle, message: string, out: NodeProblems): boolean {
  const said = sentence(message);
  const named = (name: string) => bundle.steps.filter((s) => s.name === name);
  const from = /^Edge from '(.*)' (points at a missing step|leads back to the start step)$/.exec(message);
  if (from) {
    const missing = from[2] === "points at a missing step";
    const ids = new Set(bundle.steps.map((s) => s.id));
    const sources = named(from[1]!).map((s) => s.id);
    const lines = bundle.edges.filter((e) => sources.includes(e.from_step_id) && (missing ? !ids.has(e.to_step_id) : bundle.steps.find((s) => s.id === e.to_step_id)?.kind === "start"));
    for (const e of lines) add(out.edges, e.id, missing ? "This line leads to a step that isn't there." : "Nothing can lead back to the start step.");
    return lines.length > 0;
  }
  if (message === "The start step needs exactly one outgoing edge") {
    const start = bundle.steps.filter((s) => s.kind === "start");
    for (const s of start) add(out.steps, s.id, "The start step needs exactly one line out of it, to the first step.");
    return start.length > 0;
  }
  for (const name of quoted(message)) {
    const steps = named(name);
    if (!steps.length) continue;
    for (const s of steps) {
      // `stepWarnings` already says it better when nothing leaves the step.
      if (/has no outgoing edge|has nothing leaving it/.test(message) && out.steps.has(s.id)) continue;
      add(out.steps, s.id, said);
    }
    return true;
  }
  return false;
}

export function nodeProblems(bundle: ProcessBundle): NodeProblems {
  const out: NodeProblems = { steps: new Map(), edges: new Map(), process: [], total: 0 };
  // The company map is not simulated from the editor (the Sandbox runs the company from it), and its lines have no shares to add up, so nothing on it is a problem (as the editor treats it).
  if (bundle.process.is_company) return out;

  for (const [id, message] of stepWarnings(bundle)) add(out.steps, id, message);
  // A decision whose branches don't add up. (`stepWarnings` flags every step with this; stated for decisions so it holds on its own.)
  for (const s of bundle.steps) {
    if (s.kind !== "decision") continue;
    const branches = bundle.edges.filter((e) => e.from_step_id === s.id);
    const total = outgoingTotal(bundle, s.id);
    if (branches.length && Math.abs(total - 1) > TOLERANCE && !out.steps.has(s.id)) add(out.steps, s.id, `Branches add up to ${Math.round(total * 1000) / 10}%, not 100%.`);
  }
  try {
    toEngineModel(bundle, { startDate: MODEL_DATE });
  } catch (err) {
    if (!(err instanceof ModelError)) throw err;
    if (!pin(bundle, err.message, out)) {
      const said = sentence(err.message);
      if (!out.process.includes(said)) out.process.push(said);
    }
  }
  out.total = out.process.length + [...out.steps.values(), ...out.edges.values()].reduce((n, list) => n + list.length, 0);
  return out;
}

/** The editor bar's line: "1 thing to fix before this can simulate", or "N things…". Null when there is nothing to fix. */
export function problemsLine(total: number): string | null {
  return total <= 0 ? null : `${total} ${total === 1 ? "thing" : "things"} to fix before this can simulate`;
}

/** The first problem on the map, for the bar's line to jump to: a step (in map order), else a line, else none (the process itself). */
export function firstProblem(bundle: ProcessBundle, problems: NodeProblems): { kind: "step" | "edge"; id: string } | null {
  const step = bundle.steps.find((s) => problems.steps.has(s.id));
  if (step) return { kind: "step", id: step.id };
  const edge = bundle.edges.find((e) => problems.edges.has(e.id));
  return edge ? { kind: "edge", id: edge.id } : null;
}

/** Why Publish waits on the problems, or null when there are none: Publish is blocked while anything stops the process simulating. */
export function publishBlocker(total: number): string | null {
  return total <= 0 ? null : `Fix the ${total === 1 ? "thing" : `${total} things`} marked in red first: a process that can't simulate can't be published.`;
}
