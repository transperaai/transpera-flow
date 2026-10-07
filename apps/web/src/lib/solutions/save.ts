// What "Save solution" sends, and the checks behind the Server Action (app/w/[slug]/solution-actions.ts) and the in-memory
// demo store (issue #114, A49). They only reject malformed input early: the tables check the name, the shapes and the
// verdicts again, and row-level security decides who may write.

import type { BlockBundle, SolutionIssueRow, SolutionRow, SolutionVerdict } from "@transpera-flow/db";
import { parsePatches, type ScenarioPatch } from "@transpera-flow/engine";
import { solutionProblem } from "./bundle";

export const MAX_NAME = 200;
/** The table refuses a copy over 1,000,000 bytes of JSON (`octet_length`). */
export const MAX_COPY = 1_000_000;
const MAX_LEVERS = 200;

/** One issue the solution is saved against, with the automatic verdict the simulation gave. */
export interface SolutionLinkInput {
  issueId: string;
  autoVerdict: SolutionVerdict | null;
  /** 0 to 100, or null when the target wasn't checked. */
  holdsPct: number | null;
  autoNote: string;
}

export interface SolutionInput {
  name: string;
  processId: string;
  /** The revision of the process the copy was made from (live when the solution was started). */
  baseRevisionId: string;
  /** The map as the solution has it. */
  copy: BlockBundle;
  changedStepIds: string[];
  levers: ScenarioPatch[];
  /** The issues it solves; none for a solution started on its own. */
  links: SolutionLinkInput[];
}

export type SaveSolutionResult = { status: "ok"; solution: SolutionRow; links: SolutionIssueRow[] } | { status: "error"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A plain-English reason the input can't be saved, or the cleaned input. */
export function parseSolutionInput(input: unknown): { ok: true; value: SolutionInput } | { ok: false; error: string } {
  const i = input as Partial<SolutionInput> | null;
  if (!i || typeof i !== "object") return { ok: false, error: "That solution isn't valid." };
  const name = typeof i.name === "string" ? i.name.trim() : "";
  if (!name) return { ok: false, error: "Name the solution first." };
  if (name.length > MAX_NAME) return { ok: false, error: `Keep the name under ${MAX_NAME} characters.` };
  if (typeof i.processId !== "string" || !UUID.test(i.processId) || typeof i.baseRevisionId !== "string" || !UUID.test(i.baseRevisionId)) {
    return { ok: false, error: "Publish the process first: a solution is a copy of its live version." };
  }
  const problem = solutionProblem(i.copy);
  if (problem) return { ok: false, error: problem };
  const copy = i.copy as BlockBundle;
  if (new TextEncoder().encode(JSON.stringify(copy)).length > MAX_COPY) return { ok: false, error: "That solution is too big to save." };
  const changed = Array.isArray(i.changedStepIds) ? i.changedStepIds.filter((s): s is string => typeof s === "string") : [];
  const rawLevers = Array.isArray(i.levers) ? i.levers : [];
  if (rawLevers.length > MAX_LEVERS) return { ok: false, error: "That solution changes too many levers." };
  // Now that a solution's lever changes are simulated, only well-formed ones are kept (the table checks the shape again).
  const parsedLevers = parsePatches(rawLevers);
  if (!parsedLevers.ok) return { ok: false, error: "That solution's lever changes aren't valid." };
  const levers: ScenarioPatch[] = parsedLevers.patches;
  const links: SolutionLinkInput[] = [];
  for (const l of Array.isArray(i.links) ? i.links : []) {
    if (!l || typeof l !== "object" || typeof l.issueId !== "string" || !UUID.test(l.issueId)) return { ok: false, error: "That issue isn't valid." };
    if (links.some((x) => x.issueId === l.issueId)) continue;
    const verdict = l.autoVerdict === "pass" || l.autoVerdict === "fail" ? l.autoVerdict : null;
    const holds = typeof l.holdsPct === "number" && Number.isFinite(l.holdsPct) ? Math.min(100, Math.max(0, Math.round(l.holdsPct))) : null;
    links.push({ issueId: l.issueId, autoVerdict: verdict, holdsPct: verdict ? holds : null, autoNote: typeof l.autoNote === "string" ? l.autoNote.slice(0, 1000) : "" });
  }
  return { ok: true, value: { name, processId: i.processId, baseRevisionId: i.baseRevisionId, copy, changedStepIds: changed.slice(0, 2000), levers, links } };
}
