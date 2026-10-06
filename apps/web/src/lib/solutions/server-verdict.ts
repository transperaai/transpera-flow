// The automatic verdict, worked out again on the server (issue #114, A49 review). The browser shows a verdict while you edit, but
// what is stored is never what the browser sent: saving and linking simulate the stored copy here, with the engine, against the
// issue's target as it is in the database. The client's numbers are ignored. Same seeds as the Editor's compare (30 runs, seed 1).

import { isActiveStatus, listProcesses, loadIssue, loadProcessBundle, ModelError, toEngineModel, type BlockBundle, type Db, type IssueRow, type ProcessBundle } from "@transpera-flow/db";
import { simulate, type EngineModel, type ScenarioPatch, type SimulationResult } from "@transpera-flow/engine";
import { currentArea, issueAboutProcess, leafIds, solutionIssueOf } from "./area";
import { bundleFromSolution } from "./bundle";
import { withLeverChanges } from "./levers";
import { checkTarget, type TargetVerdict } from "./verdict";

/** Why an issue can't be linked to a solution of `processId`, in plain English, or null. */
export function linkProblem(issue: IssueRow | null, processId: string): string | null {
  if (!issue || issue.status === "dismissed") return "That issue isn't there, or has been dismissed, so a solution can't be linked to it.";
  if (issue.source === "detected") return "That issue is only a detection. Acknowledge it as an issue first.";
  if (!isActiveStatus(issue.status)) return "That issue is already resolved or marked won't fix, so a solution can't be linked to it. Reopen it first.";
  if (!issueAboutProcess(issue, processId)) return "That issue is about another process, so this solution can't be linked to it.";
  return null;
}

/** The process as it was at `revisionId`, for simulating a solution against it. */
async function baseBundle(db: Db, workspaceId: string, processId: string, revisionId: string): Promise<ProcessBundle | null> {
  const { data: workspace } = await db.from("workspaces").select("id, name, slug, settings").eq("id", workspaceId).maybeSingle();
  if (!workspace) return null;
  const process = (await listProcesses(db, workspaceId)).find((p) => p.id === processId);
  if (!process) return null;
  const { draft_revision_id: _draft, ...row } = process;
  void _draft;
  return loadProcessBundle(db, workspace, row, revisionId);
}

export type ServerVerdict = { ok: true; verdict: TargetVerdict } | { ok: false; message: string };

/** A solution's copy simulated once on top of its base: what every linked issue is then checked against. */
export interface CopyRun {
  base: ProcessBundle;
  solved: ProcessBundle;
  model: EngineModel;
  result: SimulationResult;
  /** Steps the copy has that the base doesn't. */
  added: string[];
}

/**
 * Simulate the copy on top of `base` (30 runs, seed 1, as the Editor's compare does), with the solution's lever changes applied
 * (B4: a solution's numbers mean the same everywhere; a change whose target is gone is left out).
 */
export function simulateCopy(base: ProcessBundle, copy: BlockBundle, levers: readonly ScenarioPatch[] = []): { ok: true; run: CopyRun } | { ok: false; message: string } {
  const solved = bundleFromSolution(base, { steps: copy });
  let model: EngineModel;
  try {
    model = withLeverChanges(toEngineModel(solved), levers).model;
  } catch (err) {
    if (err instanceof ModelError) return { ok: false, message: `The solution can't be simulated: ${err.message}.` };
    throw err;
  }
  const result = simulate(model, 30, 1);
  const was = new Set(base.steps.map((s) => s.id));
  return { ok: true, run: { base, solved, model, result, added: solved.steps.filter((s) => !was.has(s.id)).map((s) => s.id) } };
}

/** Check a simulated copy against one issue's target. */
export function verdictFromRun(run: CopyRun, issue: IssueRow, processId: string): TargetVerdict {
  const { solved, model, result, added } = run;
  const asIssue = solutionIssueOf(issue, processId, solved.steps);
  const area = leafIds(solved.steps, asIssue.whole ? solved.steps.filter((s) => s.parent_step_id === null).map((s) => s.id) : currentArea(asIssue, solved.steps, added));
  return checkTarget({ target: asIssue.target, model, result, area });
}

/** The pure part: simulate the copy on top of `base` and check it against the issue's target. */
export function verdictForCopy(args: { base: ProcessBundle; copy: BlockBundle; issue: IssueRow; processId: string; levers?: readonly ScenarioPatch[] }): ServerVerdict {
  const r = simulateCopy(args.base, args.copy, args.levers);
  return r.ok ? { ok: true, verdict: verdictFromRun(r.run, args.issue, args.processId) } : r;
}

/**
 * Checks a stored copy of a process against an issue's target. Returns why the link isn't allowed (closed, a detection, another
 * process), or the verdict: `unchecked` when the target can't be turned into a number the simulation computes.
 */
export async function serverVerdict(args: {
  db: Db;
  workspaceId: string;
  processId: string;
  baseRevisionId: string;
  copy: BlockBundle;
  /** The solution's lever changes: the copy is simulated with them applied. */
  levers?: readonly ScenarioPatch[];
  issueId: string;
  /** The base bundle and the simulated copy, if the caller has already loaded and run them for another link: they are reused, not run again. */
  base?: ProcessBundle;
  run?: CopyRun;
}): Promise<ServerVerdict & { base?: ProcessBundle; run?: CopyRun }> {
  const issue = await loadIssue(args.db, args.workspaceId, args.issueId);
  const problem = linkProblem(issue, args.processId);
  if (problem) return { ok: false, message: problem };
  const base = args.base ?? (await baseBundle(args.db, args.workspaceId, args.processId, args.baseRevisionId));
  if (!base) return { ok: false, message: "The process or its live version is no longer there. Reload and try again." };
  let run = args.run;
  if (!run) {
    const sim = simulateCopy(base, args.copy, args.levers);
    if (!sim.ok) return sim;
    run = sim.run;
  }
  return { ok: true, verdict: verdictFromRun(run, issue!, args.processId), base, run };
}
